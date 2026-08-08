import { createHash, randomBytes } from 'node:crypto';

import { type AsyncDatabaseAdapter, type AsyncDatabaseSession } from '../db/asyncAdapter';
import { databaseTimestamp, nullableDatabaseTimestamp } from '../db/databaseTimestamp';
import {
  type AuthenticatedOperatorSession,
  type CreatedOperatorSession,
  type OperatorCredentialsRecord,
  type OperatorUserRecord,
} from './operatorIdentityRepository';
import {
  type CreateOperatorInput,
  type OperatorIdentityStore,
} from './operatorIdentityStore';
import { normalizeEmail } from './userRepository';
import { normalizeOperatorRole, type OperatorRole } from './operatorAuthorization';

const OPERATOR_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

interface OperatorRow {
  id: number;
  email: string;
  password_hash: string;
  role: OperatorRole;
  status: 'active' | 'disabled';
  must_change_password: boolean | number;
  last_login_at: string | Date | null;
  created_at: string | Date;
}

interface OperatorSessionRow extends OperatorRow {
  expires_at: string | Date;
}

export class AsyncOperatorIdentityRepository implements OperatorIdentityStore {
  constructor(
    private readonly database: AsyncDatabaseAdapter,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async needsSetup(): Promise<boolean> {
    const rows = await this.database.query<{ count: number | string }>({
      text: 'SELECT COUNT(*) AS count FROM operator_users WHERE bootstrap_root = $1;',
      values: [true],
    });
    return Number(rows[0]?.count ?? 0) === 0;
  }

  createInitial(email: unknown, passwordHash: string): Promise<OperatorUserRecord> {
    return this.insertUser(email, passwordHash, 'super_admin', false, true);
  }

  create(input: CreateOperatorInput): Promise<OperatorUserRecord> {
    return this.insertUser(
      input.email,
      input.passwordHash,
      normalizeOperatorRole(input.role),
      true,
      false,
    );
  }

  async list(): Promise<OperatorUserRecord[]> {
    const rows = await this.database.query<OperatorRow>({
      text: `SELECT ${OPERATOR_COLUMNS} FROM operator_users ORDER BY id ASC;`,
    });
    return rows.map(toOperatorUser);
  }

  async findCredentialsByEmail(email: unknown): Promise<OperatorCredentialsRecord | null> {
    let normalizedEmail: string;
    try {
      normalizedEmail = normalizeEmail(email);
    } catch {
      return null;
    }
    const rows = await this.database.query<OperatorRow>({
      text: `SELECT ${OPERATOR_COLUMNS} FROM operator_users WHERE email = $1 LIMIT 1;`,
      values: [normalizedEmail],
    });
    return rows[0] ? toOperatorCredentials(rows[0]) : null;
  }

  async findById(id: number): Promise<OperatorUserRecord | null> {
    const rows = await this.database.query<OperatorRow>({
      text: `SELECT ${OPERATOR_COLUMNS} FROM operator_users WHERE id = $1 LIMIT 1;`,
      values: [id],
    });
    return rows[0] ? toOperatorUser(rows[0]) : null;
  }

  createSession(userId: number): Promise<CreatedOperatorSession> {
    const token = randomBytes(32).toString('base64url');
    const now = this.now();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + OPERATOR_SESSION_TTL_MS).toISOString();
    return this.database.transaction(async (session) => {
      await session.execute({
        text: `
          INSERT INTO operator_sessions (operator_user_id, token_hash, expires_at)
          VALUES ($1, $2, $3);
        `,
        values: [userId, hashOperatorToken(token), expiresAt],
      });
      await session.execute({
        text: 'UPDATE operator_users SET last_login_at = $2, updated_at = $2 WHERE id = $1;',
        values: [userId, nowIso],
      });
      return { token, expiresAt };
    });
  }

  async findByToken(token: string): Promise<AuthenticatedOperatorSession | null> {
    if (!token.trim()) return null;
    const tokenHash = hashOperatorToken(token);
    const now = this.now().toISOString();
    return this.database.transaction(async (session) => {
      const rows = await session.query<OperatorSessionRow>({
        text: `
          SELECT ${OPERATOR_COLUMNS_WITH_ALIAS}, session.expires_at
          FROM operator_sessions session
          JOIN operator_users operator ON operator.id = session.operator_user_id
          WHERE session.token_hash = $1 AND session.revoked_at IS NULL
            AND session.expires_at > $2 AND operator.status = 'active'
          LIMIT 1;
        `,
        values: [tokenHash, now],
      });
      const row = rows[0];
      if (!row) return null;
      await session.execute({
        text: 'UPDATE operator_sessions SET last_seen_at = $2 WHERE token_hash = $1;',
        values: [tokenHash, now],
      });
      return { user: toOperatorUser(row), expiresAt: databaseTimestamp(row.expires_at) };
    });
  }

  async revokeToken(token: string): Promise<void> {
    if (!token.trim()) return;
    await this.database.execute({
      text: `
        UPDATE operator_sessions SET revoked_at = COALESCE(revoked_at, $2)
        WHERE token_hash = $1;
      `,
      values: [hashOperatorToken(token), this.now().toISOString()],
    });
  }

  updatePassword(userId: number, passwordHash: string): Promise<void> {
    const now = this.now().toISOString();
    return this.database.transaction(async (session) => {
      const result = await session.execute({
        text: `
          UPDATE operator_users SET password_hash = $2, must_change_password = $3,
            updated_at = $4 WHERE id = $1;
        `,
        values: [userId, passwordHash, false, now],
      });
      if (result.rowCount !== 1) throw new Error('operator user not found');
      await session.execute({
        text: `
          UPDATE operator_sessions SET revoked_at = COALESCE(revoked_at, $2)
          WHERE operator_user_id = $1;
        `,
        values: [userId, now],
      });
    });
  }

  private insertUser(
    email: unknown,
    passwordHash: string,
    role: OperatorRole,
    mustChangePassword: boolean,
    bootstrapRoot: boolean,
  ): Promise<OperatorUserRecord> {
    const normalizedEmail = normalizeEmail(email);
    return this.database.transaction(async (session) => {
      try {
        await session.execute({
          text: `
            INSERT INTO operator_users (
              email, password_hash, role, must_change_password, bootstrap_root
            ) VALUES ($1, $2, $3, $4, $5);
          `,
          values: [normalizedEmail, passwordHash, role, mustChangePassword, bootstrapRoot],
        });
      } catch (error) {
        throw operatorIdentityWriteError(error, bootstrapRoot);
      }
      const created = await findCredentialsByEmail(session, normalizedEmail);
      if (!created) throw new Error('created operator could not be loaded');
      return toPublicOperator(created);
    });
  }
}

const OPERATOR_COLUMNS = [
  'id',
  'email',
  'password_hash',
  'role',
  'status',
  'must_change_password',
  'last_login_at',
  'created_at',
].join(', ');

const OPERATOR_COLUMNS_WITH_ALIAS = [
  'operator.id',
  'operator.email',
  'operator.password_hash',
  'operator.role',
  'operator.status',
  'operator.must_change_password',
  'operator.last_login_at',
  'operator.created_at',
].join(', ');

function hashOperatorToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function findCredentialsByEmail(
  session: AsyncDatabaseSession,
  email: string,
): Promise<OperatorCredentialsRecord | null> {
  const rows = await session.query<OperatorRow>({
    text: `SELECT ${OPERATOR_COLUMNS} FROM operator_users WHERE email = $1 LIMIT 1;`,
    values: [email],
  });
  return rows[0] ? toOperatorCredentials(rows[0]) : null;
}

function operatorIdentityWriteError(error: unknown, bootstrapRoot: boolean): Error {
  const message = error instanceof Error ? error.message : 'operator write failed';
  if (/unique|duplicate/i.test(message)) {
    return new Error(bootstrapRoot ? 'operator setup is already complete' : 'operator record already exists');
  }
  return error instanceof Error ? error : new Error(message);
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
    mustChangePassword: row.must_change_password === true || Number(row.must_change_password) === 1,
    lastLoginAt: nullableDatabaseTimestamp(row.last_login_at),
    createdAt: databaseTimestamp(row.created_at),
  };
}

function toPublicOperator(user: OperatorCredentialsRecord): OperatorUserRecord {
  const { passwordHash: _, ...publicUser } = user;
  return publicUser;
}
