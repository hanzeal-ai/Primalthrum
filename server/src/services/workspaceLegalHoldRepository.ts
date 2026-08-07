import { randomUUID } from 'node:crypto';

import { initializeSchema } from '../db/schema';
import { type DatabaseAdapter } from '../db/adapter';
import { sqlValue } from '../db/sql';

export const LEGAL_HOLD_BASES = [
  'litigation',
  'regulatory',
  'investigation',
  'tax',
  'contractual',
] as const;

export type LegalHoldBasis = typeof LEGAL_HOLD_BASES[number];
export type LegalHoldStatus = 'active' | 'released';

export interface WorkspaceLegalHoldRecord {
  id: number;
  holdRef: string;
  workspaceId: number;
  workspaceName: string;
  externalCaseRef: string;
  basis: LegalHoldBasis;
  reason: string;
  status: LegalHoldStatus;
  revision: number;
  createdByOperatorId: number;
  releasedByOperatorId: number | null;
  releaseReason: string;
  releasedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

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
  released_at: string | null;
  created_at: string;
  updated_at: string;
}

export class WorkspaceLegalHoldError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'REVISION_CONFLICT' | 'SELF_RELEASE_FORBIDDEN' | 'INVALID',
    message: string,
  ) {
    super(message);
  }
}

export class WorkspaceLegalHoldRepository {
  constructor(
    private readonly db: DatabaseAdapter,
    private readonly now: () => Date = () => new Date(),
  ) {
    initializeSchema(db);
  }

  list(limit = 100): WorkspaceLegalHoldRecord[] {
    const boundedLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    return this.db.query<LegalHoldRow>(`
      SELECT ${HOLD_COLUMNS}
      FROM workspace_legal_holds hold
      JOIN workspaces workspace ON workspace.id = hold.workspace_id
      ORDER BY CASE hold.status WHEN 'active' THEN 0 ELSE 1 END,
        hold.created_at DESC, hold.id DESC
      LIMIT ${boundedLimit};
    `).map(toRecord);
  }

  find(id: number): WorkspaceLegalHoldRecord | null {
    const row = this.db.query<LegalHoldRow>(`
      SELECT ${HOLD_COLUMNS}
      FROM workspace_legal_holds hold
      JOIN workspaces workspace ON workspace.id = hold.workspace_id
      WHERE hold.id = ${sqlValue(id)}
      LIMIT 1;
    `)[0];
    return row ? toRecord(row) : null;
  }

  activeCount(workspaceId: number): number {
    const row = this.db.query<{ count: number }>(`
      SELECT COUNT(*) AS count
      FROM workspace_legal_holds
      WHERE workspace_id = ${sqlValue(positiveId(workspaceId, 'workspaceId'))}
        AND status = 'active';
    `)[0];
    return Number(row?.count ?? 0);
  }

  create(input: {
    workspaceId: unknown;
    externalCaseRef: unknown;
    basis: unknown;
    reason: unknown;
    operatorUserId: number;
  }): WorkspaceLegalHoldRecord {
    const workspaceId = positiveId(input.workspaceId, 'workspaceId');
    const externalCaseRef = boundedText(input.externalCaseRef, 'externalCaseRef', 3, 120);
    const basis = legalHoldBasis(input.basis);
    const reason = boundedText(input.reason, 'reason', 10, 1000);
    const operatorUserId = positiveId(input.operatorUserId, 'operatorUserId');
    const holdRef = `LH-${randomUUID().toUpperCase()}`;
    const eventId = randomUUID();
    const createdAt = this.now().toISOString();

    try {
      this.db.run(`
        PRAGMA foreign_keys = ON;
        BEGIN IMMEDIATE;
        INSERT INTO workspace_legal_holds (
          hold_ref, workspace_id, external_case_ref, basis, reason,
          created_by_operator_id, created_at, updated_at
        ) VALUES (
          ${sqlValue(holdRef)}, ${sqlValue(workspaceId)}, ${sqlValue(externalCaseRef)},
          ${sqlValue(basis)}, ${sqlValue(reason)}, ${sqlValue(operatorUserId)},
          ${sqlValue(createdAt)}, ${sqlValue(createdAt)}
        );
        INSERT INTO workspace_legal_hold_events (
          event_id, legal_hold_id, operator_user_id, action, revision, created_at
        ) VALUES (
          ${sqlValue(eventId)}, last_insert_rowid(), ${sqlValue(operatorUserId)},
          'placed', 1, ${sqlValue(createdAt)}
        );
        COMMIT;
      `);
    } catch (error) {
      throw legalHoldWriteError(error);
    }
    const record = this.db.query<LegalHoldRow>(`
      SELECT ${HOLD_COLUMNS}
      FROM workspace_legal_holds hold
      JOIN workspaces workspace ON workspace.id = hold.workspace_id
      WHERE hold.hold_ref = ${sqlValue(holdRef)} LIMIT 1;
    `)[0];
    if (!record) throw new WorkspaceLegalHoldError('INVALID', 'legal hold could not be loaded');
    return toRecord(record);
  }

  release(idValue: unknown, input: {
    expectedRevision: unknown;
    releaseReason: unknown;
    operatorUserId: number;
  }): WorkspaceLegalHoldRecord {
    const id = positiveId(idValue, 'id');
    const expectedRevision = positiveId(input.expectedRevision, 'expectedRevision');
    const releaseReason = boundedText(input.releaseReason, 'releaseReason', 10, 1000);
    const operatorUserId = positiveId(input.operatorUserId, 'operatorUserId');
    const current = this.find(id);
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

    const releasedAt = this.now().toISOString();
    const eventId = randomUUID();
    try {
      this.db.run(`
        PRAGMA foreign_keys = ON;
        BEGIN IMMEDIATE;
        UPDATE workspace_legal_holds
        SET status = 'released', revision = revision + 1,
          released_by_operator_id = ${sqlValue(operatorUserId)},
          release_reason = ${sqlValue(releaseReason)}, released_at = ${sqlValue(releasedAt)},
          updated_at = ${sqlValue(releasedAt)}
        WHERE id = ${sqlValue(id)} AND status = 'active'
          AND revision = ${sqlValue(expectedRevision)}
          AND created_by_operator_id <> ${sqlValue(operatorUserId)};
        INSERT INTO workspace_legal_hold_events (
          event_id, legal_hold_id, operator_user_id, action, revision, created_at
        )
        SELECT ${sqlValue(eventId)}, ${sqlValue(id)}, ${sqlValue(operatorUserId)},
          'released', ${sqlValue(expectedRevision + 1)}, ${sqlValue(releasedAt)}
        WHERE changes() = 1;
        COMMIT;
      `);
    } catch (error) {
      throw legalHoldWriteError(error);
    }
    const released = this.find(id);
    if (
      !released
      || released.status !== 'released'
      || released.releasedByOperatorId !== operatorUserId
      || released.revision !== expectedRevision + 1
    ) {
      throw new WorkspaceLegalHoldError('REVISION_CONFLICT', 'legal hold revision conflict');
    }
    return released;
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
  const message = error instanceof Error ? error.message : 'legal hold write failed';
  if (/unique/i.test(message)) {
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
    releasedAt: row.released_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
