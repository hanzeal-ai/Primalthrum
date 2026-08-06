import { createHash, randomUUID } from 'node:crypto';

import { initializeSchema } from '../db/schema';
import { SqliteDatabase, sqlValue } from '../db/sqlite';

export interface OperatorFeatureFlagOverride {
  id: number;
  featureFlagId: number;
  workspaceId: number;
  workspaceName: string;
  enabled: boolean;
  reason: string;
  active: boolean;
  revision: number;
  createdByOperatorId: number;
  updatedByOperatorId: number;
  createdAt: string;
  updatedAt: string;
}

export interface OperatorFeatureFlag {
  id: number;
  key: string;
  description: string;
  enabled: boolean;
  killSwitch: boolean;
  rolloutPercentage: number;
  revision: number;
  createdByOperatorId: number;
  updatedByOperatorId: number;
  createdAt: string;
  updatedAt: string;
  overrides: OperatorFeatureFlagOverride[];
}

export interface OperatorFeatureFlagEvent {
  id: number;
  eventId: string;
  featureFlagId: number;
  operatorUserId: number;
  action: 'created' | 'updated' | 'override_created' | 'override_revoked';
  snapshot: Record<string, unknown>;
  createdAt: string;
}

interface FlagRow {
  id: number;
  key: string;
  description: string;
  enabled: number;
  kill_switch: number;
  rollout_percentage: number;
  revision: number;
  created_by_operator_id: number;
  updated_by_operator_id: number;
  created_at: string;
  updated_at: string;
}

interface OverrideRow {
  id: number;
  feature_flag_id: number;
  workspace_id: number;
  workspace_name: string;
  enabled: number;
  reason: string;
  active: number;
  revision: number;
  created_by_operator_id: number;
  updated_by_operator_id: number;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  id: number;
  event_id: string;
  feature_flag_id: number;
  operator_user_id: number;
  action: OperatorFeatureFlagEvent['action'];
  snapshot_json: string;
  created_at: string;
}

export class OperatorFeatureFlagRepository {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {
    initializeSchema(db);
  }

  list(): OperatorFeatureFlag[] {
    return this.db.query<FlagRow>(`
      SELECT * FROM operator_feature_flags ORDER BY key ASC;
    `).map((row) => this.toFlag(row));
  }

  find(id: number): OperatorFeatureFlag | null {
    const row = this.db.query<FlagRow>(`
      SELECT * FROM operator_feature_flags WHERE id = ${sqlValue(id)} LIMIT 1;
    `)[0];
    return row ? this.toFlag(row) : null;
  }

  create(input: {
    key: unknown;
    description: unknown;
    enabled: unknown;
    killSwitch: unknown;
    rolloutPercentage: unknown;
    operatorUserId: number;
  }): OperatorFeatureFlag {
    const key = normalizeFlagKey(input.key);
    const description = boundedText(input.description, 'feature flag description', 12, 500);
    const enabled = requiredBoolean(input.enabled, 'feature flag enabled');
    const killSwitch = requiredBoolean(input.killSwitch, 'feature flag kill switch');
    const rolloutPercentage = percentage(input.rolloutPercentage);
    const eventId = randomUUID();
    const now = this.now().toISOString();
    const snapshot = JSON.stringify({ key, description, enabled, killSwitch, rolloutPercentage, revision: 1 });
    this.db.run(`
      BEGIN IMMEDIATE;
      INSERT INTO operator_feature_flags (
        key, description, enabled, kill_switch, rollout_percentage,
        created_by_operator_id, updated_by_operator_id, created_at, updated_at
      ) VALUES (
        ${sqlValue(key)}, ${sqlValue(description)}, ${sqlValue(enabled)},
        ${sqlValue(killSwitch)}, ${sqlValue(rolloutPercentage)},
        ${sqlValue(input.operatorUserId)}, ${sqlValue(input.operatorUserId)},
        ${sqlValue(now)}, ${sqlValue(now)}
      );
      INSERT INTO operator_feature_flag_events (
        event_id, feature_flag_id, operator_user_id, action, snapshot_json, created_at
      ) SELECT
        ${sqlValue(eventId)}, id, ${sqlValue(input.operatorUserId)}, 'created',
        ${sqlValue(snapshot)}, ${sqlValue(now)}
      FROM operator_feature_flags WHERE key = ${sqlValue(key)};
      COMMIT;
    `);
    const created = this.db.query<FlagRow>(`
      SELECT * FROM operator_feature_flags WHERE key = ${sqlValue(key)} LIMIT 1;
    `)[0];
    if (!created) throw new Error('feature flag could not be created');
    return this.toFlag(created);
  }

  update(id: number, input: {
    description: unknown;
    enabled: unknown;
    killSwitch: unknown;
    rolloutPercentage: unknown;
    expectedRevision: unknown;
    operatorUserId: number;
  }): OperatorFeatureFlag {
    const existing = this.requiredFlag(id);
    const expectedRevision = revision(input.expectedRevision);
    if (existing.revision !== expectedRevision) throw new Error('feature flag revision conflict');
    const description = boundedText(input.description, 'feature flag description', 12, 500);
    const enabled = requiredBoolean(input.enabled, 'feature flag enabled');
    const killSwitch = requiredBoolean(input.killSwitch, 'feature flag kill switch');
    const rolloutPercentage = percentage(input.rolloutPercentage);
    const eventId = randomUUID();
    const now = this.now().toISOString();
    const nextRevision = expectedRevision + 1;
    const snapshot = JSON.stringify({
      key: existing.key,
      description,
      enabled,
      killSwitch,
      rolloutPercentage,
      revision: nextRevision,
    });
    this.db.run(`
      BEGIN IMMEDIATE;
      UPDATE operator_feature_flags
      SET description = ${sqlValue(description)},
          enabled = ${sqlValue(enabled)},
          kill_switch = ${sqlValue(killSwitch)},
          rollout_percentage = ${sqlValue(rolloutPercentage)},
          revision = ${sqlValue(nextRevision)},
          updated_by_operator_id = ${sqlValue(input.operatorUserId)},
          updated_at = ${sqlValue(now)}
      WHERE id = ${sqlValue(id)} AND revision = ${sqlValue(expectedRevision)};
      INSERT INTO operator_feature_flag_events (
        event_id, feature_flag_id, operator_user_id, action, snapshot_json, created_at
      ) SELECT
        ${sqlValue(eventId)}, ${sqlValue(id)}, ${sqlValue(input.operatorUserId)},
        'updated', ${sqlValue(snapshot)}, ${sqlValue(now)}
      WHERE changes() = 1;
      COMMIT;
    `);
    this.assertEvent(eventId, 'feature flag revision conflict');
    return this.requiredFlag(id);
  }

  createOverride(flagId: number, input: {
    workspaceId: unknown;
    enabled: unknown;
    reason: unknown;
    operatorUserId: number;
  }): OperatorFeatureFlagOverride {
    this.requiredFlag(flagId);
    const workspaceId = positiveInteger(input.workspaceId, 'workspace');
    if (!this.workspaceExists(workspaceId)) throw new Error('workspace not found');
    const enabled = requiredBoolean(input.enabled, 'feature flag override enabled');
    const reason = boundedText(input.reason, 'feature flag override reason', 12, 500);
    const eventId = randomUUID();
    const now = this.now().toISOString();
    const snapshot = JSON.stringify({ workspaceId, enabled, reason, active: true, revision: 1 });
    this.db.run(`
      BEGIN IMMEDIATE;
      INSERT INTO operator_feature_flag_overrides (
        feature_flag_id, workspace_id, enabled, reason,
        created_by_operator_id, updated_by_operator_id, created_at, updated_at
      ) VALUES (
        ${sqlValue(flagId)}, ${sqlValue(workspaceId)}, ${sqlValue(enabled)},
        ${sqlValue(reason)}, ${sqlValue(input.operatorUserId)},
        ${sqlValue(input.operatorUserId)}, ${sqlValue(now)}, ${sqlValue(now)}
      );
      INSERT INTO operator_feature_flag_events (
        event_id, feature_flag_id, operator_user_id, action, snapshot_json, created_at
      ) VALUES (
        ${sqlValue(eventId)}, ${sqlValue(flagId)}, ${sqlValue(input.operatorUserId)},
        'override_created', ${sqlValue(snapshot)}, ${sqlValue(now)}
      );
      COMMIT;
    `);
    const created = this.db.query<OverrideRow>(`
      ${overrideSelect()}
      WHERE override.feature_flag_id = ${sqlValue(flagId)}
        AND override.workspace_id = ${sqlValue(workspaceId)}
        AND override.active = 1
      LIMIT 1;
    `)[0];
    if (!created) throw new Error('feature flag override could not be created');
    return toOverride(created);
  }

  revokeOverride(flagId: number, overrideId: number, input: {
    expectedRevision: unknown;
    operatorUserId: number;
  }): OperatorFeatureFlagOverride {
    this.requiredFlag(flagId);
    const existing = this.findOverride(flagId, overrideId);
    if (!existing) throw new Error('feature flag override not found');
    const expectedRevision = revision(input.expectedRevision);
    if (!existing.active || existing.revision !== expectedRevision) {
      throw new Error('feature flag override revision conflict');
    }
    const eventId = randomUUID();
    const now = this.now().toISOString();
    const nextRevision = expectedRevision + 1;
    const snapshot = JSON.stringify({
      workspaceId: existing.workspaceId,
      enabled: existing.enabled,
      reason: existing.reason,
      active: false,
      revision: nextRevision,
    });
    this.db.run(`
      BEGIN IMMEDIATE;
      UPDATE operator_feature_flag_overrides
      SET active = 0,
          revision = ${sqlValue(nextRevision)},
          updated_by_operator_id = ${sqlValue(input.operatorUserId)},
          updated_at = ${sqlValue(now)}
      WHERE id = ${sqlValue(overrideId)}
        AND feature_flag_id = ${sqlValue(flagId)}
        AND active = 1
        AND revision = ${sqlValue(expectedRevision)};
      INSERT INTO operator_feature_flag_events (
        event_id, feature_flag_id, operator_user_id, action, snapshot_json, created_at
      ) SELECT
        ${sqlValue(eventId)}, ${sqlValue(flagId)}, ${sqlValue(input.operatorUserId)},
        'override_revoked', ${sqlValue(snapshot)}, ${sqlValue(now)}
      WHERE changes() = 1;
      COMMIT;
    `);
    this.assertEvent(eventId, 'feature flag override revision conflict');
    const revoked = this.findOverride(flagId, overrideId);
    if (!revoked) throw new Error('feature flag override not found');
    return revoked;
  }

  listEvents(flagId: number, limit = 100): OperatorFeatureFlagEvent[] {
    this.requiredFlag(flagId);
    const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 200);
    return this.db.query<EventRow>(`
      SELECT * FROM operator_feature_flag_events
      WHERE feature_flag_id = ${sqlValue(flagId)}
      ORDER BY id DESC LIMIT ${boundedLimit};
    `).map((row) => ({
      id: Number(row.id),
      eventId: row.event_id,
      featureFlagId: Number(row.feature_flag_id),
      operatorUserId: Number(row.operator_user_id),
      action: row.action,
      snapshot: parseObject(row.snapshot_json),
      createdAt: row.created_at,
    }));
  }

  evaluate(key: string, input: {
    workspaceId?: number;
    subjectKey?: string;
  } = {}): boolean {
    const normalizedKey = normalizeFlagKey(key);
    const row = this.db.query<FlagRow>(`
      SELECT * FROM operator_feature_flags WHERE key = ${sqlValue(normalizedKey)} LIMIT 1;
    `)[0];
    if (!row || Boolean(row.kill_switch)) return false;
    if (input.workspaceId) {
      const override = this.db.query<{ enabled: number }>(`
        SELECT enabled FROM operator_feature_flag_overrides
        WHERE feature_flag_id = ${sqlValue(row.id)}
          AND workspace_id = ${sqlValue(input.workspaceId)}
          AND active = 1
        LIMIT 1;
      `)[0];
      if (override) return Boolean(override.enabled);
    }
    if (!Boolean(row.enabled) || row.rollout_percentage <= 0) return false;
    if (row.rollout_percentage >= 100) return true;
    const subject = input.subjectKey ?? String(input.workspaceId ?? 'global');
    return rolloutBucket(`${normalizedKey}:${subject}`) < row.rollout_percentage;
  }

  private toFlag(row: FlagRow): OperatorFeatureFlag {
    const overrides = this.db.query<OverrideRow>(`
      ${overrideSelect()}
      WHERE override.feature_flag_id = ${sqlValue(row.id)}
      ORDER BY override.active DESC, override.id DESC;
    `).map(toOverride);
    return {
      id: Number(row.id),
      key: row.key,
      description: row.description,
      enabled: Boolean(row.enabled),
      killSwitch: Boolean(row.kill_switch),
      rolloutPercentage: Number(row.rollout_percentage),
      revision: Number(row.revision),
      createdByOperatorId: Number(row.created_by_operator_id),
      updatedByOperatorId: Number(row.updated_by_operator_id),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      overrides,
    };
  }

  private requiredFlag(id: number): OperatorFeatureFlag {
    const flag = this.find(id);
    if (!flag) throw new Error('feature flag not found');
    return flag;
  }

  private findOverride(flagId: number, overrideId: number): OperatorFeatureFlagOverride | null {
    const row = this.db.query<OverrideRow>(`
      ${overrideSelect()}
      WHERE override.id = ${sqlValue(overrideId)}
        AND override.feature_flag_id = ${sqlValue(flagId)}
      LIMIT 1;
    `)[0];
    return row ? toOverride(row) : null;
  }

  private workspaceExists(id: number): boolean {
    return Boolean(this.db.query<{ id: number }>(`
      SELECT id FROM workspaces WHERE id = ${sqlValue(id)} LIMIT 1;
    `)[0]);
  }

  private assertEvent(eventId: string, message: string): void {
    const event = this.db.query<{ id: number }>(`
      SELECT id FROM operator_feature_flag_events
      WHERE event_id = ${sqlValue(eventId)} LIMIT 1;
    `)[0];
    if (!event) throw new Error(message);
  }
}

function overrideSelect(): string {
  return `
    SELECT
      override.*,
      workspace.name AS workspace_name
    FROM operator_feature_flag_overrides override
    JOIN workspaces workspace ON workspace.id = override.workspace_id
  `;
}

function toOverride(row: OverrideRow): OperatorFeatureFlagOverride {
  return {
    id: Number(row.id),
    featureFlagId: Number(row.feature_flag_id),
    workspaceId: Number(row.workspace_id),
    workspaceName: row.workspace_name,
    enabled: Boolean(row.enabled),
    reason: row.reason,
    active: Boolean(row.active),
    revision: Number(row.revision),
    createdByOperatorId: Number(row.created_by_operator_id),
    updatedByOperatorId: Number(row.updated_by_operator_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeFlagKey(value: unknown): string {
  if (typeof value !== 'string') throw new Error('feature flag key is invalid');
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length < 3
    || normalized.length > 80
    || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(normalized)
  ) {
    throw new Error('feature flag key is invalid');
  }
  return normalized;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${field} is invalid`);
  return value;
}

function percentage(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 100) {
    throw new Error('feature flag rollout percentage is invalid');
  }
  return parsed;
}

function revision(value: unknown): number {
  return positiveInteger(value, 'revision');
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${field} is invalid`);
  return parsed;
}

function boundedText(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== 'string') throw new Error(`${field} is invalid`);
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) throw new Error(`${field} is invalid`);
  return normalized;
}

function rolloutBucket(value: string): number {
  return Number.parseInt(createHash('sha256').update(value).digest('hex').slice(0, 8), 16) % 100;
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
