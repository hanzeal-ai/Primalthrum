import { type AsyncDatabaseAdapter, type AsyncDatabaseSession } from '../db/asyncAdapter';
import { databaseTimestamp, nullableDatabaseTimestamp } from '../db/databaseTimestamp';
import {
  normalizeSupportGrantPermissions,
  type SupportGrantPermission,
} from './operatorAuthorization';
import { type SupportAccessGrantRecord } from './supportAccessRepository';
import {
  type CreateSupportAccessGrantInput,
  type SupportAccessStore,
} from './supportAccessStore';

const MAX_GRANT_MS = 4 * 60 * 60 * 1000;
const MIN_GRANT_MS = 5 * 60 * 1000;

interface SupportGrantRow {
  id: number;
  workspace_id: number;
  operator_user_id: number;
  permissions_json: string;
  reason: string;
  ticket_ref: string;
  expires_at: string | Date;
  revoked_at: string | Date | null;
  created_by_operator_id: number;
  created_at: string | Date;
}

export class AsyncSupportAccessRepository implements SupportAccessStore {
  constructor(
    private readonly database: AsyncDatabaseAdapter,
    private readonly now: () => Date = () => new Date(),
  ) {}

  create(input: CreateSupportAccessGrantInput): Promise<SupportAccessGrantRecord> {
    assertPositiveId(input.workspaceId, 'workspaceId');
    assertPositiveId(input.operatorUserId, 'operatorUserId');
    assertPositiveId(input.createdByOperatorId, 'createdByOperatorId');
    const permissions = normalizeSupportGrantPermissions(input.permissions);
    const reason = normalizeText(input.reason, 'reason', 12, 500);
    const ticketRef = normalizeText(input.ticketRef, 'ticketRef', 3, 80);
    const now = this.now();
    const nowIso = now.toISOString();
    const expiresAt = normalizeExpiry(input.expiresAt, now);
    return this.database.transaction(async (session) => {
      await this.assertTargetsExist(session, input.workspaceId, input.operatorUserId, true);
      const existing = await session.query<{ id: number }>({
        text: `
          SELECT id FROM operator_support_grants
          WHERE workspace_id = $1 AND operator_user_id = $2
            AND revoked_at IS NULL AND expires_at > $3
          LIMIT 1;
        `,
        values: [input.workspaceId, input.operatorUserId, nowIso],
      });
      if (existing[0]) throw new Error('an active support grant already exists');
      const result = await session.query<{ id: number }>({
        text: `
          INSERT INTO operator_support_grants (
            workspace_id, operator_user_id, permissions_json, reason,
            ticket_ref, expires_at, created_by_operator_id
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING id;
        `,
        values: [
          input.workspaceId,
          input.operatorUserId,
          JSON.stringify(permissions),
          reason,
          ticketRef,
          expiresAt,
          input.createdByOperatorId,
        ],
      });
      const created = result[0] ? await this.findIn(session, Number(result[0].id), now) : null;
      if (!created) throw new Error('created support grant could not be loaded');
      return created;
    });
  }

  async list(operatorUserId?: number): Promise<SupportAccessGrantRecord[]> {
    const values = operatorUserId ? [operatorUserId] : [];
    const rows = await this.database.query<SupportGrantRow>({
      text: `
        SELECT ${SUPPORT_GRANT_COLUMNS} FROM operator_support_grants
        ${operatorUserId ? 'WHERE operator_user_id = $1' : ''}
        ORDER BY id DESC LIMIT 200;
      `,
      values,
    });
    const now = this.now();
    return rows.map((row) => toSupportGrant(row, now));
  }

  async findActive(id: number, operatorUserId: number): Promise<SupportAccessGrantRecord | null> {
    const now = this.now();
    const rows = await this.database.query<SupportGrantRow>({
      text: `
        SELECT ${SUPPORT_GRANT_COLUMNS} FROM operator_support_grants
        WHERE id = $1 AND operator_user_id = $2
          AND revoked_at IS NULL AND expires_at > $3
        LIMIT 1;
      `,
      values: [id, operatorUserId, now.toISOString()],
    });
    return rows[0] ? toSupportGrant(rows[0], now) : null;
  }

  revoke(id: number, revokedByOperatorId: number): Promise<SupportAccessGrantRecord | null> {
    assertPositiveId(id, 'id');
    assertPositiveId(revokedByOperatorId, 'revokedByOperatorId');
    const now = this.now();
    const nowIso = now.toISOString();
    return this.database.transaction(async (session) => {
      const existing = await this.findIn(
        session,
        id,
        now,
        this.database.dialect === 'postgres',
      );
      if (!existing || existing.revokedAt) return existing;
      const result = await session.execute({
        text: `
          UPDATE operator_support_grants
          SET revoked_at = $2, revoked_by_operator_id = $3
          WHERE id = $1 AND revoked_at IS NULL;
        `,
        values: [id, nowIso, revokedByOperatorId],
      });
      if (result.rowCount !== 1) return this.findIn(session, id, now);
      return this.findIn(session, id, now);
    });
  }

  private async findIn(
    session: AsyncDatabaseSession,
    id: number,
    now: Date,
    lock = false,
  ): Promise<SupportAccessGrantRecord | null> {
    const rows = await session.query<SupportGrantRow>({
      text: `
        SELECT ${SUPPORT_GRANT_COLUMNS} FROM operator_support_grants
        WHERE id = $1 LIMIT 1${lock ? ' FOR UPDATE' : ''};
      `,
      values: [id],
    });
    return rows[0] ? toSupportGrant(rows[0], now) : null;
  }

  private async assertTargetsExist(
    session: AsyncDatabaseSession,
    workspaceId: number,
    operatorUserId: number,
    lock: boolean,
  ): Promise<void> {
    const lockClause = lock && this.database.dialect === 'postgres' ? ' FOR UPDATE' : '';
    const workspaces = await session.query<{ id: number }>({
      text: `SELECT id FROM workspaces WHERE id = $1 LIMIT 1${lockClause};`,
      values: [workspaceId],
    });
    if (!workspaces[0]) throw new Error('workspace not found');
    const operators = await session.query<{ role: string; status: string }>({
      text: `SELECT role, status FROM operator_users WHERE id = $1 LIMIT 1${lockClause};`,
      values: [operatorUserId],
    });
    const operator = operators[0];
    if (!operator || operator.status !== 'active') throw new Error('operator not found');
    if (!['super_admin', 'support'].includes(operator.role)) {
      throw new Error('support grants can only target support operators');
    }
  }
}

const SUPPORT_GRANT_COLUMNS = [
  'id',
  'workspace_id',
  'operator_user_id',
  'permissions_json',
  'reason',
  'ticket_ref',
  'expires_at',
  'revoked_at',
  'created_by_operator_id',
  'created_at',
].join(', ');

function normalizeExpiry(value: unknown, now: Date): string {
  if (typeof value !== 'string') throw new Error('expiresAt is required');
  const expiresAt = new Date(value);
  if (Number.isNaN(expiresAt.getTime())) throw new Error('expiresAt must be a valid timestamp');
  const duration = expiresAt.getTime() - now.getTime();
  if (duration < MIN_GRANT_MS || duration > MAX_GRANT_MS) {
    throw new Error('support access must last between 5 minutes and 4 hours');
  }
  return expiresAt.toISOString();
}

function normalizeText(value: unknown, field: string, minimum: number, maximum: number): string {
  if (typeof value !== 'string') throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new Error(`${field} must contain ${minimum}-${maximum} characters`);
  }
  return normalized;
}

function assertPositiveId(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} is invalid`);
}

function toSupportGrant(row: SupportGrantRow, now: Date): SupportAccessGrantRecord {
  const expiresAt = databaseTimestamp(row.expires_at);
  const revokedAt = nullableDatabaseTimestamp(row.revoked_at);
  const status = revokedAt
    ? 'revoked'
    : new Date(expiresAt).getTime() <= now.getTime() ? 'expired' : 'active';
  return {
    id: Number(row.id),
    workspaceId: Number(row.workspace_id),
    operatorUserId: Number(row.operator_user_id),
    permissions: JSON.parse(row.permissions_json) as SupportGrantPermission[],
    reason: row.reason,
    ticketRef: row.ticket_ref,
    expiresAt,
    revokedAt,
    createdByOperatorId: Number(row.created_by_operator_id),
    createdAt: databaseTimestamp(row.created_at),
    status,
  };
}
