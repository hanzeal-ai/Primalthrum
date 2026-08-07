import {
  type AsyncDatabaseAdapter,
  type AsyncDatabaseSession,
} from '../db/asyncAdapter';
import { nullableDatabaseTimestamp } from '../db/databaseTimestamp';
import { DEFAULT_WORKSPACE_ID } from '../db/workspaceDefaults';
import {
  normalizeEmail,
  type PublicUserRecord,
  toPublicUserRecord,
  type UserRecord,
} from './userRepository';

interface UserRow {
  id: number;
  workspace_id: number;
  email: string;
  password_hash: string;
  role: string;
  email_verified_at: string | Date | null;
}

const USER_SELECT = `
  SELECT id, workspace_id, email, password_hash, role, email_verified_at
  FROM users
`;

async function findByEmail(
  database: AsyncDatabaseSession,
  normalizedEmail: string,
): Promise<UserRecord | null> {
  const rows = await database.query<UserRow>({
    text: `${USER_SELECT} WHERE email = $1 LIMIT 1;`,
    values: [normalizedEmail],
  });
  return rows[0] ? toUserRecord(rows[0]) : null;
}

function toUserRecord(row: UserRow): UserRecord {
  return {
    id: Number(row.id),
    workspaceId: Number(row.workspace_id),
    email: row.email,
    passwordHash: row.password_hash,
    role: row.role,
    emailVerifiedAt: nullableDatabaseTimestamp(row.email_verified_at),
  };
}

export class AsyncUserRepository {
  constructor(private readonly database: AsyncDatabaseAdapter) {}

  async hasAdmin(): Promise<boolean> {
    const rows = await this.database.query<{ count: number | string }>({
      text: `SELECT COUNT(*) AS count FROM users WHERE role = 'admin';`,
    });
    return Number(rows[0]?.count ?? 0) > 0;
  }

  createAdmin(email: string, passwordHash: string): Promise<PublicUserRecord> {
    const normalizedEmail = normalizeEmail(email);
    return this.database.transaction(async (transaction) => {
      await transaction.execute({
        text: `
          INSERT INTO users (workspace_id, email, password_hash, role, email_verified_at)
          VALUES ($1, $2, $3, 'admin', CURRENT_TIMESTAMP);
        `,
        values: [DEFAULT_WORKSPACE_ID, normalizedEmail, passwordHash],
      });
      const created = await findByEmail(transaction, normalizedEmail);
      if (!created) throw new Error('created admin user could not be loaded');
      await transaction.execute({
        text: `
          INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
          VALUES ($1, $2, 'owner', 'active')
          ON CONFLICT(workspace_id, user_id) DO UPDATE SET
            role = 'owner',
            status = 'active',
            updated_at = CURRENT_TIMESTAMP;
        `,
        values: [DEFAULT_WORKSPACE_ID, created.id],
      });
      return toPublicUserRecord(created);
    });
  }

  async createUser(
    email: string,
    passwordHash: string,
    emailVerified = false,
  ): Promise<UserRecord> {
    const normalizedEmail = normalizeEmail(email);
    const verifiedAt = emailVerified ? new Date() : null;
    const rows = await this.database.query<UserRow>({
      text: `
        INSERT INTO users (
          workspace_id,
          email,
          password_hash,
          role,
          email_verified_at
        ) VALUES ($1, $2, $3, 'member', $4)
        RETURNING id, workspace_id, email, password_hash, role, email_verified_at;
      `,
      values: [DEFAULT_WORKSPACE_ID, normalizedEmail, passwordHash, verifiedAt],
    });
    if (!rows[0]) throw new Error('created user could not be loaded');
    return toUserRecord(rows[0]);
  }

  findByEmail(email: string): Promise<UserRecord | null> {
    return findByEmail(this.database, normalizeEmail(email));
  }

  async findById(id: number): Promise<UserRecord | null> {
    const rows = await this.database.query<UserRow>({
      text: `${USER_SELECT} WHERE id = $1 LIMIT 1;`,
      values: [id],
    });
    return rows[0] ? toUserRecord(rows[0]) : null;
  }

  async markEmailVerified(
    userId: number,
    verifiedAt = new Date().toISOString(),
  ): Promise<void> {
    await this.database.execute({
      text: `
        UPDATE users
        SET email_verified_at = COALESCE(email_verified_at, $1),
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $2;
      `,
      values: [verifiedAt, userId],
    });
  }

  async updatePassword(userId: number, passwordHash: string): Promise<void> {
    await this.database.execute({
      text: `
        UPDATE users
        SET password_hash = $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2;
      `,
      values: [passwordHash, userId],
    });
  }
}
