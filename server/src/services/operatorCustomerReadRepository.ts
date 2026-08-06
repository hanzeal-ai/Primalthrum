import { initializeSchema } from '../db/schema';
import { SqliteDatabase, sqlValue } from '../db/sqlite';

export interface OperatorCustomerUserSummary {
  userId: number;
  userRef: string;
  workspaceId: number;
  workspaceName: string;
  role: string;
  status: string;
  emailVerified: boolean;
  mfaEnabled: boolean;
  lastSessionAt: string | null;
  createdAt: string;
}

interface CustomerUserRow {
  user_id: number;
  workspace_id: number;
  workspace_name: string;
  role: string;
  status: string;
  email_verified: number;
  mfa_enabled: number;
  last_session_at: string | null;
  created_at: string;
}

export class OperatorCustomerReadRepository {
  constructor(private readonly db: SqliteDatabase) {
    initializeSchema(db);
  }

  listUsers(workspaceId: number | undefined, limit = 100): OperatorCustomerUserSummary[] {
    const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 200);
    const workspaceFilter = workspaceId
      ? `WHERE membership.workspace_id = ${sqlValue(workspaceId)}`
      : '';
    return this.db.query<CustomerUserRow>(`
      SELECT
        users.id AS user_id,
        membership.workspace_id,
        workspaces.name AS workspace_name,
        membership.role,
        membership.status,
        CASE WHEN users.email_verified_at IS NULL THEN 0 ELSE 1 END AS email_verified,
        CASE WHEN EXISTS (
          SELECT 1 FROM user_mfa_factors factor
          WHERE factor.user_id = users.id AND factor.state = 'enabled'
        ) THEN 1 ELSE 0 END AS mfa_enabled,
        (
          SELECT MAX(COALESCE(session.last_seen_at, session.created_at))
          FROM sessions session
          WHERE session.user_id = users.id
        ) AS last_session_at,
        users.created_at
      FROM workspace_memberships membership
      JOIN users ON users.id = membership.user_id
      JOIN workspaces ON workspaces.id = membership.workspace_id
      ${workspaceFilter}
      ORDER BY users.id DESC, membership.workspace_id DESC
      LIMIT ${boundedLimit};
    `).map(toCustomerUserSummary);
  }
}

function toCustomerUserSummary(row: CustomerUserRow): OperatorCustomerUserSummary {
  return {
    userId: Number(row.user_id),
    userRef: `USR-${String(row.user_id).padStart(6, '0')}`,
    workspaceId: Number(row.workspace_id),
    workspaceName: row.workspace_name,
    role: row.role,
    status: row.status,
    emailVerified: Boolean(row.email_verified),
    mfaEnabled: Boolean(row.mfa_enabled),
    lastSessionAt: row.last_session_at,
    createdAt: row.created_at,
  };
}
