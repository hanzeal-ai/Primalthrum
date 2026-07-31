import { initializeSchema } from '../db/schema';
import { SqliteDatabase, sqlValue } from '../db/sqlite';
import { LocalSecretVault } from './localSecretVault';

export interface ProviderConfigRecord {
  id: number;
  workspaceId: number;
  name: string;
  type: string;
  config: Record<string, unknown>;
  secretRef: string;
}

export interface CreateProviderConfigInput {
  name: unknown;
  type: unknown;
  config?: unknown;
  secret?: unknown;
}

export interface UpdateProviderConfigInput {
  name?: unknown;
  type?: unknown;
  config?: unknown;
  secret?: unknown;
}

interface ProviderConfigRow {
  id: number;
  workspace_id: number;
  name: string;
  type: string;
  config_json: string;
  secret_ref: string;
}

export class ProviderConfigRepository {
  private readonly secrets: LocalSecretVault;

  constructor(private readonly db: SqliteDatabase) {
    initializeSchema(db);
    this.secrets = new LocalSecretVault(db);
  }

  create(input: CreateProviderConfigInput, workspaceId: number): ProviderConfigRecord {
    const name = normalizeIdentifier(input.name, 'provider config name');
    const type = normalizeIdentifier(input.type, 'provider type');
    const config = normalizeConfig(input.config);
    const secretRef = typeof input.secret === 'undefined'
      ? ''
      : this.secrets.create(normalizeSecret(input.secret), workspaceId);

    this.db.run(`
      INSERT INTO provider_configs (
        workspace_id,
        name,
        type,
        config_json,
        secret_ref
      )
      VALUES (
        ${sqlValue(workspaceId)},
        ${sqlValue(name)},
        ${sqlValue(type)},
        ${sqlValue(JSON.stringify(config))},
        ${sqlValue(secretRef)}
      );
    `);

    const created = this.findByName(name, workspaceId);
    if (!created) {
      throw new Error('created provider config could not be loaded');
    }
    return created;
  }

  list(workspaceId: number): ProviderConfigRecord[] {
    return this.db.query<ProviderConfigRow>(`
      SELECT id, workspace_id, name, type, config_json, secret_ref
      FROM provider_configs
      WHERE workspace_id = ${sqlValue(workspaceId)}
      ORDER BY id ASC;
    `).map(toProviderConfigRecord);
  }

  findById(id: number, workspaceId: number): ProviderConfigRecord | null {
    const rows = this.db.query<ProviderConfigRow>(`
      SELECT id, workspace_id, name, type, config_json, secret_ref
      FROM provider_configs
      WHERE id = ${sqlValue(id)} AND workspace_id = ${sqlValue(workspaceId)}
      LIMIT 1;
    `);
    return rows[0] ? toProviderConfigRecord(rows[0]) : null;
  }

  update(id: number, input: UpdateProviderConfigInput, workspaceId: number): ProviderConfigRecord | null {
    const current = this.findById(id, workspaceId);
    if (!current) {
      return null;
    }

    const name = typeof input.name === 'undefined'
      ? current.name
      : normalizeIdentifier(input.name, 'provider config name');
    const type = typeof input.type === 'undefined'
      ? current.type
      : normalizeIdentifier(input.type, 'provider type');
    const config = typeof input.config === 'undefined'
      ? current.config
      : normalizeConfig(input.config);
    const secretRef = this.nextSecretRef(current.secretRef, input.secret, workspaceId);

    this.db.run(`
      UPDATE provider_configs
      SET
        name = ${sqlValue(name)},
        type = ${sqlValue(type)},
        config_json = ${sqlValue(JSON.stringify(config))},
        secret_ref = ${sqlValue(secretRef)}
      WHERE id = ${sqlValue(id)} AND workspace_id = ${sqlValue(workspaceId)};
    `);

    return this.findById(id, workspaceId);
  }

  private findByName(name: string, workspaceId: number): ProviderConfigRecord | null {
    const rows = this.db.query<ProviderConfigRow>(`
      SELECT id, workspace_id, name, type, config_json, secret_ref
      FROM provider_configs
      WHERE name = ${sqlValue(name)} AND workspace_id = ${sqlValue(workspaceId)}
      LIMIT 1;
    `);
    return rows[0] ? toProviderConfigRecord(rows[0]) : null;
  }

  private nextSecretRef(
    currentSecretRef: string,
    nextSecret: unknown,
    workspaceId: number,
  ): string {
    if (typeof nextSecret === 'undefined') {
      return currentSecretRef;
    }

    const normalizedSecret = normalizeSecret(nextSecret);
    if (currentSecretRef) {
      this.secrets.update(currentSecretRef, normalizedSecret, workspaceId);
      return currentSecretRef;
    }

    return this.secrets.create(normalizedSecret, workspaceId);
  }
}

function normalizeIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function normalizeConfig(value: unknown): Record<string, unknown> {
  if (typeof value === 'undefined') {
    return {};
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('provider config must be an object');
  }

  return value as Record<string, unknown>;
}

function normalizeSecret(secret: unknown): string {
  if (typeof secret !== 'string' || !secret.trim()) {
    throw new Error('secret is required');
  }
  return secret;
}

function toProviderConfigRecord(row: ProviderConfigRow): ProviderConfigRecord {
  return {
    id: Number(row.id),
    workspaceId: Number(row.workspace_id),
    name: row.name,
    type: row.type,
    config: JSON.parse(row.config_json) as Record<string, unknown>,
    secretRef: row.secret_ref,
  };
}
