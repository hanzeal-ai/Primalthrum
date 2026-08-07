import { type DatabaseAdapter } from '../db/adapter';
import { sqlValue } from '../db/sql';
import { DEFAULT_WORKSPACE_ID } from '../db/workspaceDefaults';

export interface UserRecord {
  id: number;
  workspaceId: number;
  email: string;
  passwordHash: string;
  role: string;
  emailVerifiedAt: string | null;
}

export interface PublicUserRecord {
  id: number;
  workspaceId: number;
  email: string;
  role: string;
}

interface UserRow {
  id: number;
  workspace_id: number;
  email: string;
  password_hash: string;
  role: string;
  email_verified_at: string | null;
}

export class UserRepository {
  constructor(private readonly db: DatabaseAdapter) {
  }

  hasAdmin(): boolean {
    const rows = this.db.query<{ count: number }>(`
      SELECT COUNT(*) AS count
      FROM users
      WHERE role = 'admin';
    `);
    return Number(rows[0]?.count ?? 0) > 0;
  }

  createAdmin(email: string, passwordHash: string): PublicUserRecord {
    const normalizedEmail = normalizeEmail(email);

    this.db.run(`
      INSERT INTO users (workspace_id, email, password_hash, role, email_verified_at)
      VALUES (
        ${DEFAULT_WORKSPACE_ID},
        ${sqlValue(normalizedEmail)},
        ${sqlValue(passwordHash)},
        'admin',
        CURRENT_TIMESTAMP
      );

      INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
      VALUES (
        ${DEFAULT_WORKSPACE_ID},
        (SELECT id FROM users WHERE email = ${sqlValue(normalizedEmail)}),
        'owner',
        'active'
      )
      ON CONFLICT(workspace_id, user_id) DO UPDATE SET
        role = 'owner',
        status = 'active',
        updated_at = CURRENT_TIMESTAMP;
    `);

    const created = this.findByEmail(normalizedEmail);
    if (!created) {
      throw new Error('created admin user could not be loaded');
    }
    return toPublicUserRecord(created);
  }

  createUser(email: string, passwordHash: string, emailVerified = false): UserRecord {
    const normalizedEmail = normalizeEmail(email);
    this.db.run(`
      INSERT INTO users (workspace_id, email, password_hash, role, email_verified_at)
      VALUES (
        ${DEFAULT_WORKSPACE_ID},
        ${sqlValue(normalizedEmail)},
        ${sqlValue(passwordHash)},
        'member',
        ${emailVerified ? 'CURRENT_TIMESTAMP' : 'NULL'}
      );
    `);
    const created = this.findByEmail(normalizedEmail);
    if (!created) throw new Error('created user could not be loaded');
    return created;
  }

  findByEmail(email: string): UserRecord | null {
    const normalizedEmail = normalizeEmail(email);
    const rows = this.db.query<UserRow>(`
      SELECT id, workspace_id, email, password_hash, role, email_verified_at
      FROM users
      WHERE email = ${sqlValue(normalizedEmail)}
      LIMIT 1;
    `);
    return rows[0] ? toUserRecord(rows[0]) : null;
  }

  findById(id: number): UserRecord | null {
    const rows = this.db.query<UserRow>(`
      SELECT id, workspace_id, email, password_hash, role, email_verified_at
      FROM users
      WHERE id = ${sqlValue(id)}
      LIMIT 1;
    `);
    return rows[0] ? toUserRecord(rows[0]) : null;
  }

  markEmailVerified(userId: number, verifiedAt = new Date().toISOString()): void {
    this.db.run(`
      UPDATE users SET email_verified_at = COALESCE(email_verified_at, ${sqlValue(verifiedAt)}),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${sqlValue(userId)};
    `);
  }

  updatePassword(userId: number, passwordHash: string): void {
    this.db.run(`
      UPDATE users SET password_hash = ${sqlValue(passwordHash)}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ${sqlValue(userId)};
    `);
  }
}

export function normalizeEmail(email: unknown): string {
  if (typeof email !== 'string' || !email.trim()) {
    throw new Error('email is required');
  }

  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error('email must be valid');
  }

  return normalized;
}

export function toPublicUserRecord(user: UserRecord): PublicUserRecord {
  return {
    id: user.id,
    workspaceId: user.workspaceId,
    email: user.email,
    role: user.role,
  };
}

function toUserRecord(row: UserRow): UserRecord {
  return {
    id: Number(row.id),
    workspaceId: Number(row.workspace_id),
    email: row.email,
    passwordHash: row.password_hash,
    role: row.role,
    emailVerifiedAt: row.email_verified_at,
  };
}
