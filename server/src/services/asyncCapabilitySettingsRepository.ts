import { type AsyncDatabaseAdapter } from '../db/asyncAdapter';
import { databaseTimestamp } from '../db/databaseTimestamp';
import {
  CapabilityDisabledError,
  type CapabilityRunSnapshot,
  type CapabilitySettingRecord,
} from './capabilitySettingsRepository';

interface CapabilitySettingRow {
  workspace_id: number;
  capability_key: string;
  enabled: boolean | number;
  updated_by_user_id: number | null;
  updated_at: string | Date;
}

const CAPABILITY_COLUMNS = [
  'workspace_id', 'capability_key', 'enabled', 'updated_by_user_id', 'updated_at',
].join(', ');

export class AsyncCapabilitySettingsRepository {
  constructor(private readonly database: AsyncDatabaseAdapter) {}

  async list(workspaceId: number): Promise<CapabilitySettingRecord[]> {
    const rows = await this.database.query<CapabilitySettingRow>({
      text: `
        SELECT ${CAPABILITY_COLUMNS} FROM workspace_capability_settings
        WHERE workspace_id = $1 ORDER BY capability_key ASC;
      `,
      values: [workspaceId],
    });
    return rows.map(toRecord);
  }

  async set(
    workspaceId: number,
    capabilityKey: string,
    enabled: boolean,
    updatedByUserId: number,
  ): Promise<CapabilitySettingRecord> {
    const normalizedKey = normalizeCapabilityKey(capabilityKey);
    const rows = await this.database.query<CapabilitySettingRow>({
      text: `
        INSERT INTO workspace_capability_settings (
          workspace_id, capability_key, enabled, updated_by_user_id, updated_at
        ) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
        ON CONFLICT(workspace_id, capability_key) DO UPDATE SET
          enabled = excluded.enabled,
          updated_by_user_id = excluded.updated_by_user_id,
          updated_at = CURRENT_TIMESTAMP
        RETURNING ${CAPABILITY_COLUMNS};
      `,
      values: [workspaceId, normalizedKey, enabled, updatedByUserId],
    });
    if (!rows[0]) throw new Error('capability setting could not be loaded');
    return toRecord(rows[0]);
  }

  async snapshot(workspaceId: number, selectedKeys: string[]): Promise<CapabilityRunSnapshot> {
    const selected = [...new Set(selectedKeys.map(normalizeCapabilityKey))].sort();
    const overrides = new Map(
      (await this.list(workspaceId)).map((setting) => [setting.capabilityKey, setting.enabled]),
    );
    return {
      schemaVersion: '1.0',
      selected,
      settings: Object.fromEntries(selected.map((key) => [key, overrides.get(key) ?? true])),
    };
  }

  assertEnabled(snapshot: CapabilityRunSnapshot): void {
    const disabled = snapshot.selected.filter((key) => snapshot.settings[key] === false);
    if (disabled.length) throw new CapabilityDisabledError(disabled);
  }
}

function normalizeCapabilityKey(value: string): string {
  const normalized = value.trim();
  if (!/^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9._-]*$/.test(normalized)) {
    throw new Error('capability key has an invalid format');
  }
  const aliases: Record<string, string> = {
    'memory:none': 'memory:null',
    'cache:none': 'cache:null',
    'rag:null': 'rag:none',
  };
  return aliases[normalized] ?? normalized;
}

function toRecord(row: CapabilitySettingRow): CapabilitySettingRecord {
  return {
    workspaceId: Number(row.workspace_id),
    capabilityKey: row.capability_key,
    enabled: Boolean(row.enabled),
    updatedByUserId: row.updated_by_user_id === null ? null : Number(row.updated_by_user_id),
    updatedAt: databaseTimestamp(row.updated_at),
  };
}
