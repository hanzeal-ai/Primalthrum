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
}

interface SessionUserRow {
  user_id: number;
  workspace_id: number;
  email: string;
  role: string;
  expires_at: string;
}

export class SessionRepository {
  constructor(private readonly db: SqliteDatabase) {
    initializeSchema(db);
  }

  create(user: PublicUserRecord): CreatedSession {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

    this.db.run(`
      INSERT INTO sessions (user_id, workspace_id, token_hash, expires_at)
      VALUES (
        ${sqlValue(user.id)},
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
        u.workspace_id,
        u.email,
        u.role,
        s.expires_at
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ${sqlValue(hashToken(token))}
        AND s.revoked_at IS NULL
        AND s.expires_at > ${sqlValue(new Date().toISOString())}
      LIMIT 1;
    `);

    return rows[0] ? toAuthenticatedSession(rows[0]) : null;
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
  };
}
