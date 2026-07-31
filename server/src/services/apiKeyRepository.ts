import { createHash, randomBytes } from 'node:crypto';

import { initializeSchema } from '../db/schema';
import { SqliteDatabase, sqlValue } from '../db/sqlite';
import { type PublicUserRecord } from './userRepository';

export const API_KEY_SCOPES = [
  'agents:read',
  'agents:write',
  'agents:run',
  'agents:publish',
] as const;

export type ApiKeyScope = typeof API_KEY_SCOPES[number];

export interface ApiKeyRecord {
  id: number;
  workspaceId: number;
  name: string;
  keyPrefix: string;
  scopes: ApiKeyScope[];
  createdByUserId: number | null;
  expiresAt: string;
  lastUsedAt: string | null;
  lastUsedMethod: string;
  lastUsedPath: string;
  revokedAt: string | null;
  createdAt: string;
}

export interface CreatedApiKey extends ApiKeyRecord {
  token: string;
}

export interface ResolvedApiKey {
  id: number;
  keyPrefix: string;
  scopes: ApiKeyScope[];
  user: PublicUserRecord;
  emailVerified: boolean;
  expiresAt: string;
}

interface ApiKeyRow {
  id: number;
  workspace_id: number;
  name: string;
  key_prefix: string;
  scopes_json: string;
  created_by_user_id: number | null;
  expires_at: string;
  last_used_at: string | null;
  last_used_method: string;
  last_used_path: string;
  revoked_at: string | null;
  created_at: string;
}

interface ResolvedApiKeyRow extends ApiKeyRow {
  user_id: number;
  email: string;
  role: string;
  email_verified_at: string | null;
}

const MAX_ACTIVE_KEYS = 20;
const MAX_EXPIRY_DAYS = 365;

export class ApiKeyRepository {
  constructor(private readonly db: SqliteDatabase) {
    initializeSchema(db);
  }

  list(workspaceId: number): ApiKeyRecord[] {
    return this.db.query<ApiKeyRow>(`
      SELECT id, workspace_id, name, key_prefix, scopes_json, created_by_user_id,
        expires_at, last_used_at, last_used_method, last_used_path, revoked_at, created_at
      FROM workspace_api_keys
      WHERE workspace_id = ${sqlValue(workspaceId)}
      ORDER BY id DESC;
    `).map(toApiKeyRecord);
  }

  create(input: {
    workspaceId: number;
    name: unknown;
    scopes: unknown;
    expiresInDays: unknown;
    createdByUserId: number;
  }): CreatedApiKey {
    const name = normalizeName(input.name);
    const scopes = normalizeScopes(input.scopes);
    const expiresInDays = normalizeExpiryDays(input.expiresInDays);
    const activeCount = Number(this.db.query<{ count: number }>(`
      SELECT COUNT(*) AS count
      FROM workspace_api_keys
      WHERE workspace_id = ${sqlValue(input.workspaceId)}
        AND revoked_at IS NULL
        AND expires_at > ${sqlValue(new Date().toISOString())};
    `)[0]?.count ?? 0);
    if (activeCount >= MAX_ACTIVE_KEYS) {
      throw new Error(`workspace cannot have more than ${MAX_ACTIVE_KEYS} active API keys`);
    }

    const keyPrefix = `ptk_${randomBytes(6).toString('base64url')}`;
    const token = `${keyPrefix}_${randomBytes(32).toString('base64url')}`;
    const expiresAt = new Date(Date.now() + expiresInDays * 86_400_000).toISOString();
    this.db.run(`
      INSERT INTO workspace_api_keys (
        workspace_id, name, key_prefix, token_hash, scopes_json,
        created_by_user_id, expires_at
      ) VALUES (
        ${sqlValue(input.workspaceId)},
        ${sqlValue(name)},
        ${sqlValue(keyPrefix)},
        ${sqlValue(hashApiKey(token))},
        ${sqlValue(JSON.stringify(scopes))},
        ${sqlValue(input.createdByUserId)},
        ${sqlValue(expiresAt)}
      );
    `);
    const created = this.list(input.workspaceId).find((record) => record.keyPrefix === keyPrefix);
    if (!created) throw new Error('created API key could not be loaded');
    return { ...created, token };
  }

  resolve(token: string): ResolvedApiKey | null {
    if (!token.startsWith('ptk_') || token.length > 256) return null;
    const row = this.db.query<ResolvedApiKeyRow>(`
      SELECT k.id, k.workspace_id, k.name, k.key_prefix, k.scopes_json,
        k.created_by_user_id, k.expires_at, k.last_used_at, k.last_used_method,
        k.last_used_path, k.revoked_at, k.created_at,
        u.id AS user_id, u.email, m.role, u.email_verified_at
      FROM workspace_api_keys k
      JOIN users u ON u.id = k.created_by_user_id
      JOIN workspace_memberships m
        ON m.workspace_id = k.workspace_id
        AND m.user_id = u.id
        AND m.status = 'active'
      WHERE k.token_hash = ${sqlValue(hashApiKey(token))}
        AND k.revoked_at IS NULL
        AND k.expires_at > ${sqlValue(new Date().toISOString())}
      LIMIT 1;
    `)[0];
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
      expiresAt: row.expires_at,
    };
  }

  recordUse(apiKeyId: number, workspaceId: number, method: string, path: string): void {
    const usedAt = new Date().toISOString();
    const normalizedMethod = method.trim().toUpperCase().slice(0, 16);
    const normalizedPath = path.trim().slice(0, 256);
    this.db.run(`
      UPDATE workspace_api_keys
      SET last_used_at = ${sqlValue(usedAt)},
        last_used_method = ${sqlValue(normalizedMethod)},
        last_used_path = ${sqlValue(normalizedPath)},
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${sqlValue(apiKeyId)} AND workspace_id = ${sqlValue(workspaceId)};

      INSERT INTO api_key_usage_events (api_key_id, workspace_id, method, path, used_at)
      VALUES (
        ${sqlValue(apiKeyId)},
        ${sqlValue(workspaceId)},
        ${sqlValue(normalizedMethod)},
        ${sqlValue(normalizedPath)},
        ${sqlValue(usedAt)}
      );
    `);
  }

  revoke(workspaceId: number, apiKeyId: number): void {
    const existing = this.find(workspaceId, apiKeyId);
    if (!existing) throw new Error('API key not found');
    if (existing.revokedAt) return;
    this.db.run(`
      UPDATE workspace_api_keys
      SET revoked_at = ${sqlValue(new Date().toISOString())}, updated_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ${sqlValue(workspaceId)} AND id = ${sqlValue(apiKeyId)};
    `);
  }

  private find(workspaceId: number, apiKeyId: number): ApiKeyRecord | null {
    const row = this.db.query<ApiKeyRow>(`
      SELECT id, workspace_id, name, key_prefix, scopes_json, created_by_user_id,
        expires_at, last_used_at, last_used_method, last_used_path, revoked_at, created_at
      FROM workspace_api_keys
      WHERE workspace_id = ${sqlValue(workspaceId)} AND id = ${sqlValue(apiKeyId)}
      LIMIT 1;
    `)[0];
    return row ? toApiKeyRecord(row) : null;
  }
}

export function hashApiKey(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function normalizeName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (name.length < 2 || name.length > 64) throw new Error('API key name must be 2 to 64 characters');
  return name;
}

function normalizeScopes(value: unknown): ApiKeyScope[] {
  if (!Array.isArray(value) || !value.length) throw new Error('at least one API key scope is required');
  const scopes = [...new Set(value.map((scope) => String(scope).trim()))];
  if (scopes.some((scope) => !API_KEY_SCOPES.includes(scope as ApiKeyScope))) {
    throw new Error(`API key scopes must be one of ${API_KEY_SCOPES.join(', ')}`);
  }
  return API_KEY_SCOPES.filter((scope) => scopes.includes(scope));
}

function normalizeExpiryDays(value: unknown): number {
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > MAX_EXPIRY_DAYS) {
    throw new Error(`API key expiry must be between 1 and ${MAX_EXPIRY_DAYS} days`);
  }
  return days;
}

function parseScopes(value: string): ApiKeyScope[] {
  try {
    return normalizeScopes(JSON.parse(value));
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
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    lastUsedMethod: row.last_used_method,
    lastUsedPath: row.last_used_path,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}
