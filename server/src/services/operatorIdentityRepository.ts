import { createHash, randomBytes } from 'node:crypto';

import { initializeSchema } from '../db/schema';
import { type DatabaseAdapter } from '../db/adapter';
import { sqlValue } from '../db/sql';
import { normalizeEmail } from './userRepository';
import {
  normalizeOperatorRole,
  type OperatorRole,
} from './operatorAuthorization';

const OPERATOR_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface OperatorUserRecord {
  id: number;
  email: string;
  role: OperatorRole;
  status: 'active' | 'disabled';
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface OperatorCredentialsRecord extends OperatorUserRecord {
  passwordHash: string;
}

export interface CreatedOperatorSession {
  token: string;
  expiresAt: string;
}

export interface AuthenticatedOperatorSession {
  user: OperatorUserRecord;
  expiresAt: string;
}

interface OperatorRow {
  id: number;
  email: string;
  password_hash: string;
  role: OperatorRole;
  status: 'active' | 'disabled';
  must_change_password: number;
  last_login_at: string | null;
  created_at: string;
}

interface OperatorSessionRow extends OperatorRow {
  expires_at: string;
}

export class OperatorIdentityRepository {
  constructor(
    private readonly db: DatabaseAdapter,
    private readonly now: () => Date = () => new Date(),
  ) {
    initializeSchema(db);
  }

  needsSetup(): boolean {
    const row = this.db.query<{ count: number }>(
      'SELECT COUNT(*) AS count FROM operator_users WHERE bootstrap_root = 1;',
    )[0];
    return Number(row?.count ?? 0) === 0;
  }

  createInitial(email: unknown, passwordHash: string): OperatorUserRecord {
    if (!this.needsSetup()) throw new Error('operator setup is already complete');
    return this.insertUser(email, passwordHash, 'super_admin', false, true);
  }

  create(input: {
    email: unknown;
    passwordHash: string;
    role: unknown;
  }): OperatorUserRecord {
    return this.insertUser(
      input.email,
      input.passwordHash,
      normalizeOperatorRole(input.role),
      true,
      false,
    );
  }

  list(): OperatorUserRecord[] {
    return this.db.query<OperatorRow>(`
      SELECT id, email, password_hash, role, status, must_change_password,
        last_login_at, created_at
      FROM operator_users
      ORDER BY id ASC;
    `).map(toOperatorUser);
  }

  findCredentialsByEmail(email: unknown): OperatorCredentialsRecord | null {
    let normalizedEmail: string;
    try {
      normalizedEmail = normalizeEmail(email);
    } catch {
      return null;
    }
    const row = this.db.query<OperatorRow>(`
      SELECT id, email, password_hash, role, status, must_change_password,
        last_login_at, created_at
      FROM operator_users
      WHERE email = ${sqlValue(normalizedEmail)}
      LIMIT 1;
    `)[0];
    return row ? toOperatorCredentials(row) : null;
  }

  findById(id: number): OperatorUserRecord | null {
    const row = this.db.query<OperatorRow>(`
      SELECT id, email, password_hash, role, status, must_change_password,
        last_login_at, created_at
      FROM operator_users
      WHERE id = ${sqlValue(id)}
      LIMIT 1;
    `)[0];
    return row ? toOperatorUser(row) : null;
  }

  createSession(userId: number): CreatedOperatorSession {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(this.now().getTime() + OPERATOR_SESSION_TTL_MS).toISOString();
    this.db.run(`
      INSERT INTO operator_sessions (operator_user_id, token_hash, expires_at)
      VALUES (
        ${sqlValue(userId)},
        ${sqlValue(hashOperatorToken(token))},
        ${sqlValue(expiresAt)}
      );
      UPDATE operator_users
      SET last_login_at = ${sqlValue(this.now().toISOString())}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ${sqlValue(userId)};
    `);
    return { token, expiresAt };
  }

  findByToken(token: string): AuthenticatedOperatorSession | null {
    if (!token.trim()) return null;
    const tokenHash = hashOperatorToken(token);
    const row = this.db.query<OperatorSessionRow>(`
      SELECT u.id, u.email, u.password_hash, u.role, u.status,
        u.must_change_password, u.last_login_at, u.created_at, s.expires_at
      FROM operator_sessions s
      JOIN operator_users u ON u.id = s.operator_user_id
      WHERE s.token_hash = ${sqlValue(tokenHash)}
        AND s.revoked_at IS NULL
        AND s.expires_at > ${sqlValue(this.now().toISOString())}
        AND u.status = 'active'
      LIMIT 1;
    `)[0];
    if (!row) return null;
    this.db.run(`
      UPDATE operator_sessions
      SET last_seen_at = ${sqlValue(this.now().toISOString())}
      WHERE token_hash = ${sqlValue(tokenHash)};
    `);
    return { user: toOperatorUser(row), expiresAt: row.expires_at };
  }

  revokeToken(token: string): void {
    if (!token.trim()) return;
    this.db.run(`
      UPDATE operator_sessions
      SET revoked_at = COALESCE(revoked_at, ${sqlValue(this.now().toISOString())})
      WHERE token_hash = ${sqlValue(hashOperatorToken(token))};
    `);
  }

  updatePassword(userId: number, passwordHash: string): void {
    this.db.run(`
      UPDATE operator_users
      SET password_hash = ${sqlValue(passwordHash)}, must_change_password = 0,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${sqlValue(userId)};
      UPDATE operator_sessions
      SET revoked_at = COALESCE(revoked_at, ${sqlValue(this.now().toISOString())})
      WHERE operator_user_id = ${sqlValue(userId)};
    `);
  }

  private insertUser(
    email: unknown,
    passwordHash: string,
    role: OperatorRole,
    mustChangePassword: boolean,
    bootstrapRoot: boolean,
  ): OperatorUserRecord {
    const normalizedEmail = normalizeEmail(email);
    this.db.run(`
      INSERT INTO operator_users (
        email, password_hash, role, must_change_password, bootstrap_root
      ) VALUES (
        ${sqlValue(normalizedEmail)}, ${sqlValue(passwordHash)},
        ${sqlValue(role)}, ${sqlValue(mustChangePassword)}, ${sqlValue(bootstrapRoot)}
      );
    `);
    const created = this.findCredentialsByEmail(normalizedEmail);
    if (!created) throw new Error('created operator could not be loaded');
    return toPublicOperator(created);
  }
}

export function hashOperatorToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function toOperatorCredentials(row: OperatorRow): OperatorCredentialsRecord {
  return { ...toOperatorUser(row), passwordHash: row.password_hash };
}

function toOperatorUser(row: OperatorRow): OperatorUserRecord {
  return {
    id: Number(row.id),
    email: row.email,
    role: row.role,
    status: row.status,
    mustChangePassword: Boolean(row.must_change_password),
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
  };
}

function toPublicOperator(user: OperatorCredentialsRecord): OperatorUserRecord {
  const { passwordHash: _, ...publicUser } = user;
  return publicUser;
}
