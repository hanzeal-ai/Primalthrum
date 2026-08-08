import { randomUUID } from 'node:crypto';

import { type AsyncDatabaseAdapter, type AsyncDatabaseSession } from '../db/asyncAdapter';
import { databaseTimestamp, nullableDatabaseTimestamp } from '../db/databaseTimestamp';
import {
  LEGAL_HOLD_BASES,
  type LegalHoldBasis,
  type LegalHoldStatus,
  WorkspaceLegalHoldError,
  type WorkspaceLegalHoldRecord,
} from './workspaceLegalHoldRepository';
import {
  type CreateWorkspaceLegalHoldInput,
  type ReleaseWorkspaceLegalHoldInput,
  type WorkspaceLegalHoldStore,
} from './workspaceLegalHoldStore';

interface LegalHoldRow {
  id: number;
  hold_ref: string;
  workspace_id: number;
  workspace_name: string;
  external_case_ref: string;
  basis: LegalHoldBasis;
  reason: string;
  status: LegalHoldStatus;
  revision: number;
  created_by_operator_id: number;
  released_by_operator_id: number | null;
  release_reason: string;
  released_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export class AsyncWorkspaceLegalHoldRepository implements WorkspaceLegalHoldStore {
  constructor(
    private readonly database: AsyncDatabaseAdapter,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(limit = 100): Promise<WorkspaceLegalHoldRecord[]> {
    const boundedLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    const rows = await this.database.query<LegalHoldRow>({
      text: `
        SELECT ${HOLD_COLUMNS}
        FROM workspace_legal_holds hold
        JOIN workspaces workspace ON workspace.id = hold.workspace_id
        ORDER BY CASE hold.status WHEN 'active' THEN 0 ELSE 1 END,
          hold.created_at DESC, hold.id DESC
        LIMIT $1;
      `,
      values: [boundedLimit],
    });
    return rows.map(toRecord);
  }

  async find(id: number): Promise<WorkspaceLegalHoldRecord | null> {
    const rows = await this.database.query<LegalHoldRow>({
      text: `
        SELECT ${HOLD_COLUMNS}
        FROM workspace_legal_holds hold
        JOIN workspaces workspace ON workspace.id = hold.workspace_id
        WHERE hold.id = $1 LIMIT 1;
      `,
      values: [id],
    });
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async activeCount(workspaceId: number): Promise<number> {
    const rows = await this.database.query<{ count: number | string }>({
      text: `
        SELECT COUNT(*) AS count FROM workspace_legal_holds
        WHERE workspace_id = $1 AND status = 'active';
      `,
      values: [positiveId(workspaceId, 'workspaceId')],
    });
    return Number(rows[0]?.count ?? 0);
  }

  create(input: CreateWorkspaceLegalHoldInput): Promise<WorkspaceLegalHoldRecord> {
    const workspaceId = positiveId(input.workspaceId, 'workspaceId');
    const externalCaseRef = boundedText(input.externalCaseRef, 'externalCaseRef', 3, 120);
    const basis = legalHoldBasis(input.basis);
    const reason = boundedText(input.reason, 'reason', 10, 1000);
    const operatorUserId = positiveId(input.operatorUserId, 'operatorUserId');
    const holdRef = `LH-${randomUUID().toUpperCase()}`;
    const eventId = randomUUID();
    const createdAt = this.now().toISOString();

    return this.database.transaction(async (session) => {
      try {
        await session.execute({
          text: `
            INSERT INTO workspace_legal_holds (
              hold_ref, workspace_id, external_case_ref, basis, reason,
              created_by_operator_id, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7);
          `,
          values: [holdRef, workspaceId, externalCaseRef, basis, reason, operatorUserId, createdAt],
        });
        const hold = await this.findIn(session, 'hold.hold_ref = $1', [holdRef]);
        if (!hold) throw new WorkspaceLegalHoldError('INVALID', 'legal hold could not be loaded');
        await session.execute({
          text: `
            INSERT INTO workspace_legal_hold_events (
              event_id, legal_hold_id, operator_user_id, action, revision, created_at
            ) VALUES ($1, $2, $3, 'placed', 1, $4);
          `,
          values: [eventId, hold.id, operatorUserId, createdAt],
        });
        return hold;
      } catch (error) {
        throw legalHoldWriteError(error);
      }
    });
  }

  release(
    idValue: unknown,
    input: ReleaseWorkspaceLegalHoldInput,
  ): Promise<WorkspaceLegalHoldRecord> {
    const id = positiveId(idValue, 'id');
    const expectedRevision = positiveId(input.expectedRevision, 'expectedRevision');
    const releaseReason = boundedText(input.releaseReason, 'releaseReason', 10, 1000);
    const operatorUserId = positiveId(input.operatorUserId, 'operatorUserId');
    const releasedAt = this.now().toISOString();
    const eventId = randomUUID();

    return this.database.transaction(async (session) => {
      const current = await this.findIn(
        session,
        'hold.id = $1',
        [id],
        this.database.dialect === 'postgres',
      );
      if (!current) throw new WorkspaceLegalHoldError('NOT_FOUND', 'legal hold not found');
      if (current.createdByOperatorId === operatorUserId) {
        throw new WorkspaceLegalHoldError(
          'SELF_RELEASE_FORBIDDEN',
          'legal hold release requires a different authorized operator',
        );
      }
      if (current.status !== 'active' || current.revision !== expectedRevision) {
        throw new WorkspaceLegalHoldError('REVISION_CONFLICT', 'legal hold revision conflict');
      }
      try {
        const updated = await session.execute({
          text: `
            UPDATE workspace_legal_holds
            SET status = 'released', revision = revision + 1,
              released_by_operator_id = $2, release_reason = $3,
              released_at = $4, updated_at = $4
            WHERE id = $1 AND status = 'active' AND revision = $5
              AND created_by_operator_id <> $2;
          `,
          values: [id, operatorUserId, releaseReason, releasedAt, expectedRevision],
        });
        if (updated.rowCount !== 1) {
          throw new WorkspaceLegalHoldError('REVISION_CONFLICT', 'legal hold revision conflict');
        }
        await session.execute({
          text: `
            INSERT INTO workspace_legal_hold_events (
              event_id, legal_hold_id, operator_user_id, action, revision, created_at
            ) VALUES ($1, $2, $3, 'released', $4, $5);
          `,
          values: [eventId, id, operatorUserId, expectedRevision + 1, releasedAt],
        });
        const released = await this.findIn(session, 'hold.id = $1', [id]);
        if (!released) throw new WorkspaceLegalHoldError('NOT_FOUND', 'legal hold not found');
        return released;
      } catch (error) {
        if (error instanceof WorkspaceLegalHoldError) throw error;
        throw legalHoldWriteError(error);
      }
    });
  }

  private async findIn(
    session: AsyncDatabaseSession,
    condition: string,
    values: Array<string | number>,
    lock = false,
  ): Promise<WorkspaceLegalHoldRecord | null> {
    const rows = await session.query<LegalHoldRow>({
      text: `
        SELECT ${HOLD_COLUMNS}
        FROM workspace_legal_holds hold
        JOIN workspaces workspace ON workspace.id = hold.workspace_id
        WHERE ${condition} LIMIT 1${lock ? ' FOR UPDATE' : ''};
      `,
      values,
    });
    return rows[0] ? toRecord(rows[0]) : null;
  }
}

const HOLD_COLUMNS = [
  'hold.id',
  'hold.hold_ref',
  'hold.workspace_id',
  'workspace.name AS workspace_name',
  'hold.external_case_ref',
  'hold.basis',
  'hold.reason',
  'hold.status',
  'hold.revision',
  'hold.created_by_operator_id',
  'hold.released_by_operator_id',
  'hold.release_reason',
  'hold.released_at',
  'hold.created_at',
  'hold.updated_at',
].join(', ');

function positiveId(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new WorkspaceLegalHoldError('INVALID', `${field} is invalid`);
  }
  return parsed;
}

function boundedText(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new WorkspaceLegalHoldError(
      'INVALID',
      `${field} must contain ${minimum}-${maximum} characters`,
    );
  }
  return normalized;
}

function legalHoldBasis(value: unknown): LegalHoldBasis {
  if (typeof value !== 'string' || !LEGAL_HOLD_BASES.includes(value as LegalHoldBasis)) {
    throw new WorkspaceLegalHoldError('INVALID', 'legal hold basis is invalid');
  }
  return value as LegalHoldBasis;
}

function legalHoldWriteError(error: unknown): WorkspaceLegalHoldError {
  if (error instanceof WorkspaceLegalHoldError) return error;
  const message = error instanceof Error ? error.message : 'legal hold write failed';
  if (/unique|duplicate/i.test(message)) {
    return new WorkspaceLegalHoldError('REVISION_CONFLICT', 'legal hold case reference already exists');
  }
  if (/foreign key/i.test(message)) {
    return new WorkspaceLegalHoldError('INVALID', 'legal hold workspace or operator is invalid');
  }
  return new WorkspaceLegalHoldError('INVALID', message);
}

function toRecord(row: LegalHoldRow): WorkspaceLegalHoldRecord {
  return {
    id: Number(row.id),
    holdRef: row.hold_ref,
    workspaceId: Number(row.workspace_id),
    workspaceName: row.workspace_name,
    externalCaseRef: row.external_case_ref,
    basis: row.basis,
    reason: row.reason,
    status: row.status,
    revision: Number(row.revision),
    createdByOperatorId: Number(row.created_by_operator_id),
    releasedByOperatorId: row.released_by_operator_id === null
      ? null
      : Number(row.released_by_operator_id),
    releaseReason: row.release_reason,
    releasedAt: nullableDatabaseTimestamp(row.released_at),
    createdAt: databaseTimestamp(row.created_at),
    updatedAt: databaseTimestamp(row.updated_at),
  };
}
