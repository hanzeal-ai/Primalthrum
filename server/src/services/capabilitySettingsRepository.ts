import { SqliteDatabase, sqlValue } from '../db/sqlite';

export interface CapabilitySettingRecord {
  workspaceId: number;
  capabilityKey: string;
  enabled: boolean;
  updatedByUserId: number | null;
  updatedAt: string;
}

interface CapabilitySettingRow {
  workspace_id: number;
  capability_key: string;
  enabled: number;
  updated_by_user_id: number | null;
  updated_at: string;
}

export interface CapabilityRunSnapshot {
  schemaVersion: '1.0';
  selected: string[];
  settings: Record<string, boolean>;
}

export class CapabilitySettingsRepository {
  constructor(private readonly db: SqliteDatabase) {}

  list(workspaceId: number): CapabilitySettingRecord[] {
    return this.db.query<CapabilitySettingRow>(`
      SELECT workspace_id, capability_key, enabled, updated_by_user_id, updated_at
      FROM workspace_capability_settings
      WHERE workspace_id = ${sqlValue(workspaceId)}
      ORDER BY capability_key ASC;
    `).map(toRecord);
  }

  set(
    workspaceId: number,
    capabilityKey: string,
    enabled: boolean,
    updatedByUserId: number,
  ): CapabilitySettingRecord {
    const normalizedKey = normalizeCapabilityKey(capabilityKey);
    this.db.run(`
      INSERT INTO workspace_capability_settings (
        workspace_id,
        capability_key,
        enabled,
        updated_by_user_id,
        updated_at
      )
      VALUES (
        ${sqlValue(workspaceId)},
        ${sqlValue(normalizedKey)},
        ${enabled ? 1 : 0},
        ${sqlValue(updatedByUserId)},
        CURRENT_TIMESTAMP
      )
      ON CONFLICT(workspace_id, capability_key) DO UPDATE SET
        enabled = excluded.enabled,
        updated_by_user_id = excluded.updated_by_user_id,
        updated_at = CURRENT_TIMESTAMP;
    `);
    const record = this.list(workspaceId).find((item) => item.capabilityKey === normalizedKey);
    if (!record) throw new Error('capability setting could not be loaded');
    return record;
  }

  snapshot(workspaceId: number, selectedKeys: string[]): CapabilityRunSnapshot {
    const selected = [...new Set(selectedKeys.map(normalizeCapabilityKey))].sort();
    const overrides = new Map(
      this.list(workspaceId).map((setting) => [setting.capabilityKey, setting.enabled]),
    );
    return {
      schemaVersion: '1.0',
      selected,
      settings: Object.fromEntries(selected.map((key) => [key, overrides.get(key) ?? true])),
    };
  }

  assertEnabled(snapshot: CapabilityRunSnapshot): void {
    const disabled = snapshot.selected.filter((key) => snapshot.settings[key] === false);
    if (disabled.length) {
      throw new CapabilityDisabledError(disabled);
    }
  }
}

export class CapabilityDisabledError extends Error {
  constructor(readonly capabilityKeys: string[]) {
    super(`runtime capabilities are disabled: ${capabilityKeys.join(', ')}`);
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
    updatedAt: row.updated_at,
  };
}
