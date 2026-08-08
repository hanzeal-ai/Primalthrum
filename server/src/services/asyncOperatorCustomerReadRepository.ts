import { type AsyncDatabaseAdapter, type DatabaseParameter } from '../db/asyncAdapter';
import { databaseTimestamp, nullableDatabaseTimestamp } from '../db/databaseTimestamp';
import { type OperatorCustomerUserSummary } from './operatorCustomerReadRepository';
import { type OperatorCustomerReadStore } from './operatorCustomerReadStore';

interface CustomerUserRow {
  user_id: number;
  workspace_id: number;
  workspace_name: string;
  role: string;
  status: string;
  email_verified: boolean | number;
  mfa_enabled: boolean | number;
  last_session_at: string | Date | null;
  created_at: string | Date;
}

export class AsyncOperatorCustomerReadRepository implements OperatorCustomerReadStore {
  constructor(private readonly database: AsyncDatabaseAdapter) {}

  async listUsers(
    workspaceId: number | undefined,
    limit = 100,
  ): Promise<OperatorCustomerUserSummary[]> {
    const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 200);
    const values: DatabaseParameter[] = workspaceId ? [workspaceId, boundedLimit] : [boundedLimit];
    const rows = await this.database.query<CustomerUserRow>({
      text: `
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
            FROM sessions session WHERE session.user_id = users.id
          ) AS last_session_at,
          users.created_at
        FROM workspace_memberships membership
        JOIN users ON users.id = membership.user_id
        JOIN workspaces ON workspaces.id = membership.workspace_id
        ${workspaceId ? 'WHERE membership.workspace_id = $1' : ''}
        ORDER BY users.id DESC, membership.workspace_id DESC
        LIMIT $${workspaceId ? 2 : 1};
      `,
      values,
    });
    return rows.map(toCustomerUserSummary);
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
    emailVerified: row.email_verified === true || Number(row.email_verified) === 1,
    mfaEnabled: row.mfa_enabled === true || Number(row.mfa_enabled) === 1,
    lastSessionAt: nullableDatabaseTimestamp(row.last_session_at),
    createdAt: databaseTimestamp(row.created_at),
  };
}
