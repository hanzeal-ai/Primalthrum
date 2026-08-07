import { type AsyncDatabaseAdapter, type AsyncDatabaseSession } from '../db/asyncAdapter';
import { AsyncSecretVault } from './asyncSecretVault';
import { normalizeProviderBaseUrl } from './providerEndpointPolicy';
import {
  type CreateProviderConfigInput,
  type ProviderConfigRecord,
  type UpdateProviderConfigInput,
} from './providerConfigRepository';
import { normalizeSecret } from './secretEncryption';

interface ProviderConfigRow {
  id: number;
  workspace_id: number;
  name: string;
  type: string;
  config_json: string;
  secret_ref: string;
}

const PROVIDER_COLUMNS = 'id, workspace_id, name, type, config_json, secret_ref';

function normalizeIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function normalizeConfig(value: unknown): Record<string, unknown> {
  if (typeof value === 'undefined') return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('provider config must be an object');
  }
  const config = { ...value as Record<string, unknown> };
  if (typeof config.baseUrl !== 'undefined') {
    if (typeof config.baseUrl !== 'string') throw new Error('provider baseUrl must be a string');
    config.baseUrl = normalizeProviderBaseUrl(config.baseUrl);
  }
  return config;
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

async function findById(
  session: AsyncDatabaseSession,
  id: number,
  workspaceId: number,
): Promise<ProviderConfigRecord | null> {
  const rows = await session.query<ProviderConfigRow>({
    text: `
      SELECT ${PROVIDER_COLUMNS} FROM provider_configs
      WHERE id = $1 AND workspace_id = $2 LIMIT 1;
    `,
    values: [id, workspaceId],
  });
  return rows[0] ? toProviderConfigRecord(rows[0]) : null;
}

export class AsyncProviderConfigRepository {
  private readonly secrets: AsyncSecretVault;

  constructor(private readonly database: AsyncDatabaseAdapter, secrets?: AsyncSecretVault) {
    this.secrets = secrets ?? new AsyncSecretVault(database);
  }

  create(
    input: CreateProviderConfigInput,
    workspaceId: number,
  ): Promise<ProviderConfigRecord> {
    const name = normalizeIdentifier(input.name, 'provider config name');
    const type = normalizeIdentifier(input.type, 'provider type');
    const config = normalizeConfig(input.config);
    return this.database.transaction(async (transaction) => {
      const secretRef = typeof input.secret === 'undefined'
        ? ''
        : await this.secrets.createInSession(
          transaction,
          normalizeSecret(input.secret),
          workspaceId,
        );
      const rows = await transaction.query<ProviderConfigRow>({
        text: `
          INSERT INTO provider_configs (workspace_id, name, type, config_json, secret_ref)
          VALUES ($1, $2, $3, $4, $5)
          RETURNING ${PROVIDER_COLUMNS};
        `,
        values: [workspaceId, name, type, JSON.stringify(config), secretRef],
      });
      if (!rows[0]) throw new Error('created provider config could not be loaded');
      return toProviderConfigRecord(rows[0]);
    });
  }

  async list(workspaceId: number): Promise<ProviderConfigRecord[]> {
    const rows = await this.database.query<ProviderConfigRow>({
      text: `
        SELECT ${PROVIDER_COLUMNS} FROM provider_configs
        WHERE workspace_id = $1 ORDER BY id ASC;
      `,
      values: [workspaceId],
    });
    return rows.map(toProviderConfigRecord);
  }

  findById(id: number, workspaceId: number): Promise<ProviderConfigRecord | null> {
    return findById(this.database, id, workspaceId);
  }

  update(
    id: number,
    input: UpdateProviderConfigInput,
    workspaceId: number,
  ): Promise<ProviderConfigRecord | null> {
    return this.database.transaction(async (transaction) => {
      const current = await findById(transaction, id, workspaceId);
      if (!current) return null;
      const name = typeof input.name === 'undefined'
        ? current.name
        : normalizeIdentifier(input.name, 'provider config name');
      const type = typeof input.type === 'undefined'
        ? current.type
        : normalizeIdentifier(input.type, 'provider type');
      const config = typeof input.config === 'undefined'
        ? current.config
        : normalizeConfig(input.config);
      let secretRef = current.secretRef;
      if (typeof input.secret !== 'undefined') {
        if (secretRef) {
          await this.secrets.updateInSession(
            transaction,
            secretRef,
            normalizeSecret(input.secret),
            workspaceId,
          );
        } else {
          secretRef = await this.secrets.createInSession(
            transaction,
            normalizeSecret(input.secret),
            workspaceId,
          );
        }
      }
      const rows = await transaction.query<ProviderConfigRow>({
        text: `
          UPDATE provider_configs SET name = $1, type = $2, config_json = $3, secret_ref = $4
          WHERE id = $5 AND workspace_id = $6
          RETURNING ${PROVIDER_COLUMNS};
        `,
        values: [name, type, JSON.stringify(config), secretRef, id, workspaceId],
      });
      return rows[0] ? toProviderConfigRecord(rows[0]) : null;
    });
  }
}
