import { type DatabaseAdapter } from '../db/adapter';
import { sqlValue } from '../db/sql';
import {
  normalizeSupportGrantPermissions,
  type SupportGrantPermission,
} from './operatorAuthorization';
import { type SupportAccessStore } from './supportAccessStore';

const MAX_GRANT_MS = 4 * 60 * 60 * 1000;
const MIN_GRANT_MS = 5 * 60 * 1000;

export interface SupportAccessGrantRecord {
  id: number;
  workspaceId: number;
  operatorUserId: number;
  permissions: SupportGrantPermission[];
  reason: string;
  ticketRef: string;
  expiresAt: string;
  revokedAt: string | null;
  createdByOperatorId: number;
  createdAt: string;
  status: 'active' | 'expired' | 'revoked';
}

interface SupportGrantRow {
  id: number;
  workspace_id: number;
  operator_user_id: number;
  permissions_json: string;
  reason: string;
  ticket_ref: string;
  expires_at: string;
  revoked_at: string | null;
  created_by_operator_id: number;
  created_at: string;
}

export class SupportAccessRepository implements SupportAccessStore {
  constructor(
    private readonly db: DatabaseAdapter,
    private readonly now: () => Date = () => new Date(),
  ) {
  }

  create(input: {
    workspaceId: number;
    operatorUserId: number;
    permissions: unknown;
    reason: unknown;
    ticketRef: unknown;
    expiresAt: unknown;
    createdByOperatorId: number;
  }): SupportAccessGrantRecord {
    assertPositiveId(input.workspaceId, 'workspaceId');
    assertPositiveId(input.operatorUserId, 'operatorUserId');
    const permissions = normalizeSupportGrantPermissions(input.permissions);
    const reason = normalizeText(input.reason, 'reason', 12, 500);
    const ticketRef = normalizeText(input.ticketRef, 'ticketRef', 3, 80);
    const expiresAt = normalizeExpiry(input.expiresAt, this.now());
    this.assertTargetsExist(input.workspaceId, input.operatorUserId);
    const existing = this.db.query<{ id: number }>(`
      SELECT id FROM operator_support_grants
      WHERE workspace_id = ${sqlValue(input.workspaceId)}
        AND operator_user_id = ${sqlValue(input.operatorUserId)}
        AND revoked_at IS NULL
        AND expires_at > ${sqlValue(this.now().toISOString())}
      LIMIT 1;
    `)[0];
    if (existing) throw new Error('an active support grant already exists');
    this.db.run(`
      INSERT INTO operator_support_grants (
        workspace_id, operator_user_id, permissions_json, reason,
        ticket_ref, expires_at, created_by_operator_id
      ) VALUES (
        ${sqlValue(input.workspaceId)}, ${sqlValue(input.operatorUserId)},
        ${sqlValue(JSON.stringify(permissions))}, ${sqlValue(reason)},
        ${sqlValue(ticketRef)}, ${sqlValue(expiresAt)},
        ${sqlValue(input.createdByOperatorId)}
      );
    `);
    const row = this.db.query<SupportGrantRow>(`
      SELECT ${SUPPORT_GRANT_COLUMNS}
      FROM operator_support_grants
      ORDER BY id DESC LIMIT 1;
    `)[0];
    if (!row) throw new Error('created support grant could not be loaded');
    return toSupportGrant(row, this.now());
  }

  list(operatorUserId?: number): SupportAccessGrantRecord[] {
    const operatorClause = operatorUserId
      ? `WHERE operator_user_id = ${sqlValue(operatorUserId)}`
      : '';
    return this.db.query<SupportGrantRow>(`
      SELECT ${SUPPORT_GRANT_COLUMNS}
      FROM operator_support_grants
      ${operatorClause}
      ORDER BY id DESC
      LIMIT 200;
    `).map((row) => toSupportGrant(row, this.now()));
  }

  findActive(id: number, operatorUserId: number): SupportAccessGrantRecord | null {
    const row = this.db.query<SupportGrantRow>(`
      SELECT ${SUPPORT_GRANT_COLUMNS}
      FROM operator_support_grants
      WHERE id = ${sqlValue(id)}
        AND operator_user_id = ${sqlValue(operatorUserId)}
        AND revoked_at IS NULL
        AND expires_at > ${sqlValue(this.now().toISOString())}
      LIMIT 1;
    `)[0];
    return row ? toSupportGrant(row, this.now()) : null;
  }

  revoke(id: number, revokedByOperatorId: number): SupportAccessGrantRecord | null {
    const existing = this.find(id);
    if (!existing || existing.revokedAt) return existing;
    this.db.run(`
      UPDATE operator_support_grants
      SET revoked_at = ${sqlValue(this.now().toISOString())},
        revoked_by_operator_id = ${sqlValue(revokedByOperatorId)}
      WHERE id = ${sqlValue(id)};
    `);
    return this.find(id);
  }

  private find(id: number): SupportAccessGrantRecord | null {
    const row = this.db.query<SupportGrantRow>(`
      SELECT ${SUPPORT_GRANT_COLUMNS}
      FROM operator_support_grants
      WHERE id = ${sqlValue(id)} LIMIT 1;
    `)[0];
    return row ? toSupportGrant(row, this.now()) : null;
  }

  private assertTargetsExist(workspaceId: number, operatorUserId: number): void {
    const workspace = this.db.query<{ id: number }>(`
      SELECT id FROM workspaces WHERE id = ${sqlValue(workspaceId)} LIMIT 1;
    `)[0];
    if (!workspace) throw new Error('workspace not found');
    const operator = this.db.query<{ role: string; status: string }>(`
      SELECT role, status FROM operator_users
      WHERE id = ${sqlValue(operatorUserId)} LIMIT 1;
    `)[0];
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

function normalizeText(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): string {
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
  const status = row.revoked_at
    ? 'revoked'
    : new Date(row.expires_at).getTime() <= now.getTime() ? 'expired' : 'active';
  return {
    id: Number(row.id),
    workspaceId: Number(row.workspace_id),
    operatorUserId: Number(row.operator_user_id),
    permissions: JSON.parse(row.permissions_json) as SupportGrantPermission[],
    reason: row.reason,
    ticketRef: row.ticket_ref,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdByOperatorId: Number(row.created_by_operator_id),
    createdAt: row.created_at,
    status,
  };
}
