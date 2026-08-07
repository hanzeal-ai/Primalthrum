import { randomBytes } from 'node:crypto';

import {
  type AsyncDatabaseAdapter,
  type AsyncDatabaseSession,
} from '../db/asyncAdapter';
import {
  databaseTimestamp,
  nullableDatabaseTimestamp,
} from '../db/databaseTimestamp';
import {
  hashToken,
  type AuthenticatedSession,
  type CreatedSession,
  type SessionSecurityRecord,
} from './sessionRepository';
import { type PublicUserRecord } from './userRepository';

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;

interface SessionUserRow {
  user_id: number;
  workspace_id: number;
  email: string;
  role: string;
  expires_at: string | Date;
  email_verified_at: string | Date | null;
}

interface SessionSecurityRow {
  id: number;
  current: number;
  authentication_method: string;
  mfa_authenticated_at: string | Date | null;
  expires_at: string | Date;
  last_seen_at: string | Date | null;
  created_at: string | Date;
}

async function findByToken(
  database: AsyncDatabaseSession,
  token: string,
  updateLastSeen: boolean,
): Promise<AuthenticatedSession | null> {
  if (!token.trim()) return null;
  const tokenHash = hashToken(token);
  const rows = await database.query<SessionUserRow>({
    text: `
      SELECT
        u.id AS user_id,
        s.active_workspace_id AS workspace_id,
        u.email,
        m.role,
        s.expires_at,
        u.email_verified_at
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      JOIN workspaces w ON w.id = s.active_workspace_id
      JOIN workspace_memberships m
        ON m.user_id = u.id
        AND m.workspace_id = s.active_workspace_id
        AND m.status = 'active'
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > $2
        AND u.deleted_at IS NULL
        AND w.deleted_at IS NULL
      LIMIT 1;
    `,
    values: [tokenHash, new Date()],
  });
  if (!rows[0]) return null;

  if (updateLastSeen) {
    await database.execute({
      text: 'UPDATE sessions SET last_seen_at = $1 WHERE token_hash = $2;',
      values: [new Date(), tokenHash],
    });
  }
  return toAuthenticatedSession(rows[0]);
}

function toAuthenticatedSession(row: SessionUserRow): AuthenticatedSession {
  return {
    user: {
      id: Number(row.user_id),
      workspaceId: Number(row.workspace_id),
      email: row.email,
      role: row.role,
    },
    expiresAt: databaseTimestamp(row.expires_at),
    emailVerified: Boolean(row.email_verified_at),
  };
}

export class AsyncSessionRepository {
  constructor(private readonly database: AsyncDatabaseAdapter) {}

  async create(
    user: PublicUserRecord,
    authenticationMethod = 'password',
  ): Promise<CreatedSession> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    await this.database.execute({
      text: `
        INSERT INTO sessions (
          user_id,
          workspace_id,
          active_workspace_id,
          token_hash,
          expires_at,
          authentication_method,
          mfa_authenticated_at
        ) VALUES ($1, $2, $2, $3, $4, $5, $6);
      `,
      values: [
        user.id,
        user.workspaceId,
        hashToken(token),
        expiresAt,
        authenticationMethod,
        authenticationMethod === 'password' ? null : new Date(),
      ],
    });
    return { token, expiresAt };
  }

  findByToken(token: string): Promise<AuthenticatedSession | null> {
    return findByToken(this.database, token, true);
  }

  async revokeToken(token: string): Promise<void> {
    if (!token.trim()) return;
    await this.database.execute({
      text: 'UPDATE sessions SET revoked_at = $1 WHERE token_hash = $2;',
      values: [new Date(), hashToken(token)],
    });
  }

  async revokeAllForUser(userId: number): Promise<void> {
    await this.database.execute({
      text: `
        UPDATE sessions SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP)
        WHERE user_id = $1;
      `,
      values: [userId],
    });
  }

  async listForUser(userId: number, currentToken: string): Promise<SessionSecurityRecord[]> {
    const rows = await this.database.query<SessionSecurityRow>({
      text: `
        SELECT id,
          CASE WHEN token_hash = $1 THEN 1 ELSE 0 END AS current,
          authentication_method,
          mfa_authenticated_at,
          expires_at,
          last_seen_at,
          created_at
        FROM sessions
        WHERE user_id = $2
          AND revoked_at IS NULL
          AND expires_at > $3
        ORDER BY current DESC, COALESCE(last_seen_at, created_at) DESC, id DESC;
      `,
      values: [hashToken(currentToken), userId, new Date()],
    });
    return rows.map((row) => ({
      id: Number(row.id),
      current: Boolean(row.current),
      authenticationMethod: row.authentication_method,
      mfaAuthenticatedAt: nullableDatabaseTimestamp(row.mfa_authenticated_at),
      expiresAt: databaseTimestamp(row.expires_at),
      lastSeenAt: databaseTimestamp(row.last_seen_at ?? row.created_at),
      createdAt: databaseTimestamp(row.created_at),
    }));
  }

  revokeForUser(userId: number, sessionId: number, currentToken: string): Promise<void> {
    return this.database.transaction(async (transaction) => {
      const rows = await transaction.query<{ token_hash: string }>({
        text: `
          SELECT token_hash FROM sessions
          WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
          LIMIT 1;
        `,
        values: [sessionId, userId],
      });
      const session = rows[0];
      if (!session) throw new Error('session not found');
      if (session.token_hash === hashToken(currentToken)) {
        throw new Error('current session cannot be revoked from this action');
      }
      await transaction.execute({
        text: 'UPDATE sessions SET revoked_at = $1 WHERE id = $2 AND user_id = $3;',
        values: [new Date(), sessionId, userId],
      });
    });
  }

  revokeOthers(userId: number, currentToken: string): Promise<number> {
    return this.database.transaction(async (transaction) => {
      const currentHash = hashToken(currentToken);
      const rows = await transaction.query<{ count: number | string }>({
        text: `
          SELECT COUNT(*) AS count FROM sessions
          WHERE user_id = $1
            AND token_hash <> $2
            AND revoked_at IS NULL
            AND expires_at > $3;
        `,
        values: [userId, currentHash, new Date()],
      });
      await transaction.execute({
        text: `
          UPDATE sessions SET revoked_at = $1
          WHERE user_id = $2 AND token_hash <> $3 AND revoked_at IS NULL;
        `,
        values: [new Date(), userId, currentHash],
      });
      return Number(rows[0]?.count ?? 0);
    });
  }

  async markMfaAuthenticated(
    token: string,
    userId: number,
    authenticationMethod = 'totp',
  ): Promise<void> {
    await this.database.execute({
      text: `
        UPDATE sessions SET
          authentication_method = $1,
          mfa_authenticated_at = CURRENT_TIMESTAMP,
          last_seen_at = CURRENT_TIMESTAMP
        WHERE token_hash = $2 AND user_id = $3 AND revoked_at IS NULL;
      `,
      values: [authenticationMethod, hashToken(token), userId],
    });
  }

  async markPasswordAuthenticated(token: string, userId: number): Promise<void> {
    await this.database.execute({
      text: `
        UPDATE sessions SET
          authentication_method = 'password',
          mfa_authenticated_at = NULL,
          last_seen_at = CURRENT_TIMESTAMP
        WHERE token_hash = $1 AND user_id = $2 AND revoked_at IS NULL;
      `,
      values: [hashToken(token), userId],
    });
  }

  async switchWorkspace(token: string, userId: number, workspaceId: number): Promise<void> {
    if (!token.trim()) throw new Error('session token is required');
    const result = await this.database.execute({
      text: `
        UPDATE sessions
        SET active_workspace_id = $1, workspace_id = $1
        WHERE token_hash = $2
          AND user_id = $3
          AND revoked_at IS NULL
          AND EXISTS (
            SELECT 1
            FROM workspace_memberships m
            JOIN workspaces w ON w.id = m.workspace_id
            WHERE m.workspace_id = $1
              AND m.user_id = $3
              AND m.status = 'active'
              AND w.deleted_at IS NULL
          );
      `,
      values: [workspaceId, hashToken(token), userId],
    });
    if (result.rowCount !== 1) throw new Error('workspace membership is required');

    const selected = await findByToken(this.database, token, false);
    if (!selected || selected.user.workspaceId !== workspaceId) {
      throw new Error('workspace membership is required');
    }
  }
}
