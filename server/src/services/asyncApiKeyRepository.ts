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
  API_KEY_SCOPES,
  hashApiKey,
  MAX_ACTIVE_API_KEYS,
  normalizeApiKeyCreateInput,
  type ApiKeyRecord,
  type ApiKeyScope,
  type CreatedApiKey,
  type ResolvedApiKey,
} from './apiKeyRepository';
import { type CreateApiKeyInput } from './apiKeyStore';

interface ApiKeyRow {
  id: number;
  workspace_id: number;
  name: string;
  key_prefix: string;
  scopes_json: string;
  created_by_user_id: number | null;
  expires_at: string | Date;
  last_used_at: string | Date | null;
  last_used_method: string;
  last_used_path: string;
  revoked_at: string | Date | null;
  created_at: string | Date;
}

interface ResolvedApiKeyRow extends ApiKeyRow {
  user_id: number;
  email: string;
  role: string;
  email_verified_at: string | Date | null;
}

const API_KEY_COLUMNS = [
  'id', 'workspace_id', 'name', 'key_prefix', 'scopes_json',
  'created_by_user_id', 'expires_at', 'last_used_at', 'last_used_method',
  'last_used_path', 'revoked_at', 'created_at',
].join(', ');

export class AsyncApiKeyRepository {
  constructor(
    private readonly database: AsyncDatabaseAdapter,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(workspaceId: number): Promise<ApiKeyRecord[]> {
    const rows = await this.database.query<ApiKeyRow>({
      text: `
        SELECT ${API_KEY_COLUMNS} FROM workspace_api_keys
        WHERE workspace_id = $1 ORDER BY id DESC;
      `,
      values: [workspaceId],
    });
    return rows.map(toApiKeyRecord);
  }

  create(input: CreateApiKeyInput): Promise<CreatedApiKey> {
    const normalized = normalizeApiKeyCreateInput(input);
    const keyPrefix = `ptk_${randomBytes(6).toString('base64url')}`;
    const token = `${keyPrefix}_${randomBytes(32).toString('base64url')}`;
    const now = this.now();
    const expiresAt = new Date(
      now.getTime() + normalized.expiresInDays * 86_400_000,
    ).toISOString();
    return this.database.transaction(async (session) => {
      await this.lockWorkspace(session, input.workspaceId);
      const counts = await session.query<{ count: number | string }>({
        text: `
          SELECT COUNT(*) AS count FROM workspace_api_keys
          WHERE workspace_id = $1 AND revoked_at IS NULL AND expires_at > $2;
        `,
        values: [input.workspaceId, now.toISOString()],
      });
      if (Number(counts[0]?.count ?? 0) >= MAX_ACTIVE_API_KEYS) {
        throw new Error(`workspace cannot have more than ${MAX_ACTIVE_API_KEYS} active API keys`);
      }
      const rows = await session.query<ApiKeyRow>({
        text: `
          INSERT INTO workspace_api_keys (
            workspace_id, name, key_prefix, token_hash, scopes_json,
            created_by_user_id, expires_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING ${API_KEY_COLUMNS};
        `,
        values: [
          input.workspaceId,
          normalized.name,
          keyPrefix,
          hashApiKey(token),
          JSON.stringify(normalized.scopes),
          input.createdByUserId,
          expiresAt,
        ],
      });
      if (!rows[0]) throw new Error('created API key could not be loaded');
      return { ...toApiKeyRecord(rows[0]), token };
    });
  }

  async resolve(token: string): Promise<ResolvedApiKey | null> {
    if (!token.startsWith('ptk_') || token.length > 256) return null;
    const rows = await this.database.query<ResolvedApiKeyRow>({
      text: `
        SELECT k.id, k.workspace_id, k.name, k.key_prefix, k.scopes_json,
          k.created_by_user_id, k.expires_at, k.last_used_at,
          k.last_used_method, k.last_used_path, k.revoked_at, k.created_at,
          u.id AS user_id, u.email, m.role, u.email_verified_at
        FROM workspace_api_keys k
        JOIN users u ON u.id = k.created_by_user_id
        JOIN workspace_memberships m
          ON m.workspace_id = k.workspace_id
          AND m.user_id = u.id
          AND m.status = 'active'
        WHERE k.token_hash = $1 AND k.revoked_at IS NULL AND k.expires_at > $2
        LIMIT 1;
      `,
      values: [hashApiKey(token), this.now().toISOString()],
    });
    const row = rows[0];
    if (!row) return null;
    return {
      id: Number(row.id),
      keyPrefix: row.key_prefix,
      scopes: parseScopes(row.scopes_json),
      user: {
        id: Number(row.user_id),
        workspaceId: Number(row.workspace_id),
        email: row.email,
        role: row.role,
      },
      emailVerified: Boolean(row.email_verified_at),
      expiresAt: databaseTimestamp(row.expires_at),
    };
  }

  recordUse(
    apiKeyId: number,
    workspaceId: number,
    method: string,
    path: string,
  ): Promise<void> {
    const usedAt = this.now().toISOString();
    const normalizedMethod = method.trim().toUpperCase().slice(0, 16);
    const normalizedPath = path.trim().split(/[?#]/, 1)[0]?.slice(0, 256) ?? '';
    return this.database.transaction(async (session) => {
      const updated = await session.execute({
        text: `
          UPDATE workspace_api_keys
          SET last_used_at = $3, last_used_method = $4, last_used_path = $5,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND workspace_id = $2;
        `,
        values: [apiKeyId, workspaceId, usedAt, normalizedMethod, normalizedPath],
      });
      if (updated.rowCount !== 1) throw new Error('API key usage target does not exist');
      await session.execute({
        text: `
          INSERT INTO api_key_usage_events (
            api_key_id, workspace_id, method, path, used_at
          ) VALUES ($1, $2, $3, $4, $5);
        `,
        values: [apiKeyId, workspaceId, normalizedMethod, normalizedPath, usedAt],
      });
    });
  }

  revoke(workspaceId: number, apiKeyId: number): Promise<void> {
    return this.database.transaction(async (session) => {
      await this.lockWorkspace(session, workspaceId);
      const rows = await session.query<ApiKeyRow>({
        text: `
          SELECT ${API_KEY_COLUMNS} FROM workspace_api_keys
          WHERE workspace_id = $1 AND id = $2 LIMIT 1;
        `,
        values: [workspaceId, apiKeyId],
      });
      if (!rows[0]) throw new Error('API key not found');
      if (rows[0].revoked_at !== null) return;
      const updated = await session.execute({
        text: `
          UPDATE workspace_api_keys
          SET revoked_at = $3, updated_at = CURRENT_TIMESTAMP
          WHERE workspace_id = $1 AND id = $2 AND revoked_at IS NULL;
        `,
        values: [workspaceId, apiKeyId, this.now().toISOString()],
      });
      if (updated.rowCount !== 1) throw new Error('API key could not be revoked');
    });
  }

  private async lockWorkspace(
    session: AsyncDatabaseSession,
    workspaceId: number,
  ): Promise<void> {
    if (this.database.dialect !== 'postgres') return;
    await session.query({
      text: 'SELECT pg_advisory_xact_lock($1);',
      values: [workspaceId],
    });
  }
}

function parseScopes(value: string): ApiKeyScope[] {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return API_KEY_SCOPES.filter((scope) => parsed.includes(scope));
  } catch {
    return [];
  }
}

function toApiKeyRecord(row: ApiKeyRow): ApiKeyRecord {
  return {
    id: Number(row.id),
    workspaceId: Number(row.workspace_id),
    name: row.name,
    keyPrefix: row.key_prefix,
    scopes: parseScopes(row.scopes_json),
    createdByUserId: row.created_by_user_id === null ? null : Number(row.created_by_user_id),
    expiresAt: databaseTimestamp(row.expires_at),
    lastUsedAt: nullableDatabaseTimestamp(row.last_used_at),
    lastUsedMethod: row.last_used_method,
    lastUsedPath: row.last_used_path,
    revokedAt: nullableDatabaseTimestamp(row.revoked_at),
    createdAt: databaseTimestamp(row.created_at),
  };
}
