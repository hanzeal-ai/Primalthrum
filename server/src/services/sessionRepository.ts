import { createHash, randomBytes } from 'node:crypto';

import { initializeSchema } from '../db/schema';
import { SqliteDatabase, sqlValue } from '../db/sqlite';
import { type PublicUserRecord } from './userRepository';

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;

export interface CreatedSession {
  token: string;
  expiresAt: string;
}

export interface AuthenticatedSession {
  user: PublicUserRecord;
  expiresAt: string;
  emailVerified: boolean;
}

export interface SessionSecurityRecord {
  id: number;
  current: boolean;
  expiresAt: string;
  lastSeenAt: string;
  createdAt: string;
}

interface SessionUserRow {
  user_id: number;
  workspace_id: number;
  email: string;
  role: string;
  expires_at: string;
  email_verified_at: string | null;
}

interface SessionSecurityRow {
  id: number;
  current: number;
  expires_at: string;
  last_seen_at: string | null;
  created_at: string;
}

export class SessionRepository {
  constructor(private readonly db: SqliteDatabase) {
    initializeSchema(db);
  }

  create(user: PublicUserRecord): CreatedSession {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

    this.db.run(`
      INSERT INTO sessions (
        user_id,
        workspace_id,
        active_workspace_id,
        token_hash,
        expires_at
      )
      VALUES (
        ${sqlValue(user.id)},
        ${sqlValue(user.workspaceId)},
        ${sqlValue(user.workspaceId)},
        ${sqlValue(hashToken(token))},
        ${sqlValue(expiresAt)}
      );
    `);

    return { token, expiresAt };
  }

  findByToken(token: string): AuthenticatedSession | null {
    if (!token.trim()) {
      return null;
    }

    const rows = this.db.query<SessionUserRow>(`
      SELECT
        u.id AS user_id,
        s.active_workspace_id AS workspace_id,
        u.email,
        m.role,
        s.expires_at,
        u.email_verified_at
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      JOIN workspace_memberships m
        ON m.user_id = u.id
        AND m.workspace_id = s.active_workspace_id
        AND m.status = 'active'
      WHERE s.token_hash = ${sqlValue(hashToken(token))}
        AND s.revoked_at IS NULL
        AND s.expires_at > ${sqlValue(new Date().toISOString())}
      LIMIT 1;
    `);

    if (!rows[0]) return null;
    this.db.run(`
      UPDATE sessions SET last_seen_at = ${sqlValue(new Date().toISOString())}
      WHERE token_hash = ${sqlValue(hashToken(token))};
    `);
    return toAuthenticatedSession(rows[0]);
  }

  revokeToken(token: string): void {
    if (!token.trim()) {
      return;
    }

    this.db.run(`
      UPDATE sessions
      SET revoked_at = ${sqlValue(new Date().toISOString())}
      WHERE token_hash = ${sqlValue(hashToken(token))};
    `);
  }

  revokeAllForUser(userId: number): void {
    this.db.run(`
      UPDATE sessions SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP)
      WHERE user_id = ${sqlValue(userId)};
    `);
  }

  listForUser(userId: number, currentToken: string): SessionSecurityRecord[] {
    const currentHash = hashToken(currentToken);
    return this.db.query<SessionSecurityRow>(`
      SELECT id,
        CASE WHEN token_hash = ${sqlValue(currentHash)} THEN 1 ELSE 0 END AS current,
        expires_at, last_seen_at, created_at
      FROM sessions
      WHERE user_id = ${sqlValue(userId)}
        AND revoked_at IS NULL
        AND expires_at > ${sqlValue(new Date().toISOString())}
      ORDER BY current DESC, COALESCE(last_seen_at, created_at) DESC, id DESC;
    `).map((row) => ({
      id: Number(row.id),
      current: Boolean(row.current),
      expiresAt: row.expires_at,
      lastSeenAt: row.last_seen_at ?? row.created_at,
      createdAt: row.created_at,
    }));
  }

  revokeForUser(userId: number, sessionId: number, currentToken: string): void {
    const session = this.db.query<{ token_hash: string }>(`
      SELECT token_hash FROM sessions
      WHERE id = ${sqlValue(sessionId)}
        AND user_id = ${sqlValue(userId)}
        AND revoked_at IS NULL
      LIMIT 1;
    `)[0];
    if (!session) throw new Error('session not found');
    if (session.token_hash === hashToken(currentToken)) {
      throw new Error('current session cannot be revoked from this action');
    }
    this.db.run(`
      UPDATE sessions SET revoked_at = ${sqlValue(new Date().toISOString())}
      WHERE id = ${sqlValue(sessionId)} AND user_id = ${sqlValue(userId)};
    `);
  }

  revokeOthers(userId: number, currentToken: string): number {
    const currentHash = hashToken(currentToken);
    const count = Number(this.db.query<{ count: number }>(`
      SELECT COUNT(*) AS count FROM sessions
      WHERE user_id = ${sqlValue(userId)}
        AND token_hash <> ${sqlValue(currentHash)}
        AND revoked_at IS NULL
        AND expires_at > ${sqlValue(new Date().toISOString())};
    `)[0]?.count ?? 0);
    this.db.run(`
      UPDATE sessions SET revoked_at = ${sqlValue(new Date().toISOString())}
      WHERE user_id = ${sqlValue(userId)}
        AND token_hash <> ${sqlValue(currentHash)}
        AND revoked_at IS NULL;
    `);
    return count;
  }

  switchWorkspace(token: string, userId: number, workspaceId: number): void {
    if (!token.trim()) throw new Error('session token is required');
    this.db.run(`
      UPDATE sessions
      SET
        active_workspace_id = ${sqlValue(workspaceId)},
        workspace_id = ${sqlValue(workspaceId)}
      WHERE token_hash = ${sqlValue(hashToken(token))}
        AND user_id = ${sqlValue(userId)}
        AND revoked_at IS NULL
        AND EXISTS (
          SELECT 1
          FROM workspace_memberships m
          WHERE m.workspace_id = ${sqlValue(workspaceId)}
            AND m.user_id = ${sqlValue(userId)}
            AND m.status = 'active'
        );
    `);

    const selected = this.findByToken(token);
    if (!selected || selected.user.workspaceId !== workspaceId) {
      throw new Error('workspace membership is required');
    }
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function toAuthenticatedSession(row: SessionUserRow): AuthenticatedSession {
  return {
    user: {
      id: Number(row.user_id),
      workspaceId: Number(row.workspace_id),
      email: row.email,
      role: row.role,
    },
    expiresAt: row.expires_at,
    emailVerified: Boolean(row.email_verified_at),
  };
}
