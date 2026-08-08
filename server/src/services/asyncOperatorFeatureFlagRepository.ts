import { createHash, randomUUID } from 'node:crypto';

import { type AsyncDatabaseAdapter, type AsyncDatabaseSession } from '../db/asyncAdapter';
import { databaseTimestamp } from '../db/databaseTimestamp';
import {
  type OperatorFeatureFlag,
  type OperatorFeatureFlagEvent,
  type OperatorFeatureFlagOverride,
} from './operatorFeatureFlagRepository';
import { type OperatorFeatureFlagStore } from './operatorFeatureFlagStore';

interface FlagRow {
  id: number;
  key: string;
  description: string;
  enabled: boolean | number;
  kill_switch: boolean | number;
  rollout_percentage: number;
  revision: number;
  created_by_operator_id: number;
  updated_by_operator_id: number;
  created_at: string | Date;
  updated_at: string | Date;
}

interface OverrideRow {
  id: number;
  feature_flag_id: number;
  workspace_id: number;
  workspace_name: string;
  enabled: boolean | number;
  reason: string;
  active: boolean | number;
  revision: number;
  created_by_operator_id: number;
  updated_by_operator_id: number;
  created_at: string | Date;
  updated_at: string | Date;
}

interface EventRow {
  id: number;
  event_id: string;
  feature_flag_id: number;
  operator_user_id: number;
  action: OperatorFeatureFlagEvent['action'];
  snapshot_json: string;
  created_at: string | Date;
}

export class AsyncOperatorFeatureFlagRepository implements OperatorFeatureFlagStore {
  constructor(
    private readonly database: AsyncDatabaseAdapter,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(): Promise<OperatorFeatureFlag[]> {
    const rows = await this.database.query<FlagRow>({
      text: `SELECT ${FLAG_COLUMNS} FROM operator_feature_flags ORDER BY key ASC;`,
    });
    return Promise.all(rows.map((row) => this.toFlag(this.database, row)));
  }

  async find(id: number): Promise<OperatorFeatureFlag | null> {
    const row = await this.findRow(this.database, id);
    return row ? this.toFlag(this.database, row) : null;
  }

  create(input: Parameters<OperatorFeatureFlagStore['create']>[0]): Promise<OperatorFeatureFlag> {
    const key = normalizeFlagKey(input.key);
    const description = boundedText(input.description, 'feature flag description', 12, 500);
    const enabled = requiredBoolean(input.enabled, 'feature flag enabled');
    const killSwitch = requiredBoolean(input.killSwitch, 'feature flag kill switch');
    const rolloutPercentage = percentage(input.rolloutPercentage);
    const now = this.now().toISOString();
    return this.database.transaction(async (session) => {
      const rows = await session.query<{ id: number }>({
        text: `
          INSERT INTO operator_feature_flags (
            key, description, enabled, kill_switch, rollout_percentage,
            created_by_operator_id, updated_by_operator_id, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $7) RETURNING id;
        `,
        values: [key, description, enabled, killSwitch, rolloutPercentage, input.operatorUserId, now],
      });
      const id = Number(rows[0]?.id);
      await this.recordEvent(session, id, input.operatorUserId, 'created', {
        key, description, enabled, killSwitch, rolloutPercentage, revision: 1,
      }, now);
      return this.requiredFlagIn(session, id);
    });
  }

  update(
    id: number,
    input: Parameters<OperatorFeatureFlagStore['update']>[1],
  ): Promise<OperatorFeatureFlag> {
    const expectedRevision = revision(input.expectedRevision);
    const description = boundedText(input.description, 'feature flag description', 12, 500);
    const enabled = requiredBoolean(input.enabled, 'feature flag enabled');
    const killSwitch = requiredBoolean(input.killSwitch, 'feature flag kill switch');
    const rolloutPercentage = percentage(input.rolloutPercentage);
    const now = this.now().toISOString();
    return this.database.transaction(async (session) => {
      const existing = await this.requiredFlagIn(session, id, true);
      if (existing.revision !== expectedRevision) throw new Error('feature flag revision conflict');
      const nextRevision = expectedRevision + 1;
      const result = await session.execute({
        text: `
          UPDATE operator_feature_flags SET description = $2, enabled = $3,
            kill_switch = $4, rollout_percentage = $5, revision = $6,
            updated_by_operator_id = $7, updated_at = $8
          WHERE id = $1 AND revision = $9;
        `,
        values: [
          id, description, enabled, killSwitch, rolloutPercentage, nextRevision,
          input.operatorUserId, now, expectedRevision,
        ],
      });
      if (result.rowCount !== 1) throw new Error('feature flag revision conflict');
      await this.recordEvent(session, id, input.operatorUserId, 'updated', {
        key: existing.key, description, enabled, killSwitch, rolloutPercentage, revision: nextRevision,
      }, now);
      return this.requiredFlagIn(session, id);
    });
  }

  createOverride(
    flagId: number,
    input: Parameters<OperatorFeatureFlagStore['createOverride']>[1],
  ): Promise<OperatorFeatureFlagOverride> {
    const workspaceId = positiveInteger(input.workspaceId, 'workspace');
    const enabled = requiredBoolean(input.enabled, 'feature flag override enabled');
    const reason = boundedText(input.reason, 'feature flag override reason', 12, 500);
    const now = this.now().toISOString();
    return this.database.transaction(async (session) => {
      await this.requiredFlagIn(session, flagId, true);
      await this.requireWorkspace(session, workspaceId, true);
      const active = await session.query<{ id: number }>({
        text: `
          SELECT id FROM operator_feature_flag_overrides
          WHERE feature_flag_id = $1 AND workspace_id = $2 AND active = $3 LIMIT 1;
        `,
        values: [flagId, workspaceId, true],
      });
      if (active[0]) throw new Error('feature flag override already exists');
      const rows = await session.query<{ id: number }>({
        text: `
          INSERT INTO operator_feature_flag_overrides (
            feature_flag_id, workspace_id, enabled, reason,
            created_by_operator_id, updated_by_operator_id, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $5, $6, $6) RETURNING id;
        `,
        values: [flagId, workspaceId, enabled, reason, input.operatorUserId, now],
      });
      const overrideId = Number(rows[0]?.id);
      await this.recordEvent(session, flagId, input.operatorUserId, 'override_created', {
        workspaceId, enabled, reason, active: true, revision: 1,
      }, now);
      const created = await this.findOverride(session, flagId, overrideId);
      if (!created) throw new Error('feature flag override could not be created');
      return created;
    });
  }

  revokeOverride(
    flagId: number,
    overrideId: number,
    input: Parameters<OperatorFeatureFlagStore['revokeOverride']>[2],
  ): Promise<OperatorFeatureFlagOverride> {
    const expectedRevision = revision(input.expectedRevision);
    const now = this.now().toISOString();
    return this.database.transaction(async (session) => {
      await this.requiredFlagIn(session, flagId, true);
      const existing = await this.findOverride(
        session, flagId, overrideId, this.database.dialect === 'postgres',
      );
      if (!existing) throw new Error('feature flag override not found');
      if (!existing.active || existing.revision !== expectedRevision) {
        throw new Error('feature flag override revision conflict');
      }
      const nextRevision = expectedRevision + 1;
      const result = await session.execute({
        text: `
          UPDATE operator_feature_flag_overrides
          SET active = $4, revision = $5, updated_by_operator_id = $6, updated_at = $7
          WHERE id = $1 AND feature_flag_id = $2 AND active = $3 AND revision = $8;
        `,
        values: [
          overrideId, flagId, true, false, nextRevision,
          input.operatorUserId, now, expectedRevision,
        ],
      });
      if (result.rowCount !== 1) throw new Error('feature flag override revision conflict');
      await this.recordEvent(session, flagId, input.operatorUserId, 'override_revoked', {
        workspaceId: existing.workspaceId,
        enabled: existing.enabled,
        reason: existing.reason,
        active: false,
        revision: nextRevision,
      }, now);
      const revoked = await this.findOverride(session, flagId, overrideId);
      if (!revoked) throw new Error('feature flag override not found');
      return revoked;
    });
  }

  async listEvents(flagId: number, limit = 100): Promise<OperatorFeatureFlagEvent[]> {
    if (!await this.find(flagId)) throw new Error('feature flag not found');
    const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 200);
    const rows = await this.database.query<EventRow>({
      text: `
        SELECT id, event_id, feature_flag_id, operator_user_id, action,
          snapshot_json, created_at
        FROM operator_feature_flag_events WHERE feature_flag_id = $1
        ORDER BY id DESC LIMIT $2;
      `,
      values: [flagId, boundedLimit],
    });
    return rows.map(toEvent);
  }

  async evaluate(
    key: string,
    input: { workspaceId?: number; subjectKey?: string } = {},
  ): Promise<boolean> {
    const normalizedKey = normalizeFlagKey(key);
    const rows = await this.database.query<FlagRow>({
      text: `SELECT ${FLAG_COLUMNS} FROM operator_feature_flags WHERE key = $1 LIMIT 1;`,
      values: [normalizedKey],
    });
    const row = rows[0];
    if (!row || truthy(row.kill_switch)) return false;
    if (input.workspaceId) {
      const overrides = await this.database.query<{ enabled: boolean | number }>({
        text: `
          SELECT enabled FROM operator_feature_flag_overrides
          WHERE feature_flag_id = $1 AND workspace_id = $2 AND active = $3 LIMIT 1;
        `,
        values: [row.id, input.workspaceId, true],
      });
      if (overrides[0]) return truthy(overrides[0].enabled);
    }
    if (!truthy(row.enabled) || Number(row.rollout_percentage) <= 0) return false;
    if (Number(row.rollout_percentage) >= 100) return true;
    const subject = input.subjectKey ?? String(input.workspaceId ?? 'global');
    return rolloutBucket(`${normalizedKey}:${subject}`) < Number(row.rollout_percentage);
  }

  private async requiredFlagIn(
    session: AsyncDatabaseSession,
    id: number,
    lock = false,
  ): Promise<OperatorFeatureFlag> {
    const row = await this.findRow(session, id, lock);
    if (!row) throw new Error('feature flag not found');
    return this.toFlag(session, row);
  }

  private async findRow(
    session: AsyncDatabaseSession,
    id: number,
    lock = false,
  ): Promise<FlagRow | null> {
    const rows = await session.query<FlagRow>({
      text: `
        SELECT ${FLAG_COLUMNS} FROM operator_feature_flags
        WHERE id = $1 LIMIT 1${lock && this.database.dialect === 'postgres' ? ' FOR UPDATE' : ''};
      `,
      values: [id],
    });
    return rows[0] ?? null;
  }

  private async toFlag(
    session: AsyncDatabaseSession,
    row: FlagRow,
  ): Promise<OperatorFeatureFlag> {
    const overrides = await session.query<OverrideRow>({
      text: `
        ${OVERRIDE_SELECT} WHERE override.feature_flag_id = $1
        ORDER BY override.active DESC, override.id DESC;
      `,
      values: [row.id],
    });
    return {
      id: Number(row.id),
      key: row.key,
      description: row.description,
      enabled: truthy(row.enabled),
      killSwitch: truthy(row.kill_switch),
      rolloutPercentage: Number(row.rollout_percentage),
      revision: Number(row.revision),
      createdByOperatorId: Number(row.created_by_operator_id),
      updatedByOperatorId: Number(row.updated_by_operator_id),
      createdAt: databaseTimestamp(row.created_at),
      updatedAt: databaseTimestamp(row.updated_at),
      overrides: overrides.map(toOverride),
    };
  }

  private async findOverride(
    session: AsyncDatabaseSession,
    flagId: number,
    overrideId: number,
    lock = false,
  ): Promise<OperatorFeatureFlagOverride | null> {
    const rows = await session.query<OverrideRow>({
      text: `
        ${OVERRIDE_SELECT} WHERE override.id = $1 AND override.feature_flag_id = $2
        LIMIT 1${lock ? ' FOR UPDATE' : ''};
      `,
      values: [overrideId, flagId],
    });
    return rows[0] ? toOverride(rows[0]) : null;
  }

  private async requireWorkspace(
    session: AsyncDatabaseSession,
    workspaceId: number,
    lock: boolean,
  ): Promise<void> {
    const rows = await session.query<{ id: number }>({
      text: `
        SELECT id FROM workspaces WHERE id = $1 LIMIT 1
        ${lock && this.database.dialect === 'postgres' ? 'FOR UPDATE' : ''};
      `,
      values: [workspaceId],
    });
    if (!rows[0]) throw new Error('workspace not found');
  }

  private async recordEvent(
    session: AsyncDatabaseSession,
    flagId: number,
    operatorUserId: number,
    action: OperatorFeatureFlagEvent['action'],
    snapshot: Record<string, unknown>,
    now: string,
  ): Promise<void> {
    await session.execute({
      text: `
        INSERT INTO operator_feature_flag_events (
          event_id, feature_flag_id, operator_user_id, action, snapshot_json, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6);
      `,
      values: [randomUUID(), flagId, operatorUserId, action, JSON.stringify(snapshot), now],
    });
  }
}

const FLAG_COLUMNS = [
  'id', 'key', 'description', 'enabled', 'kill_switch', 'rollout_percentage',
  'revision', 'created_by_operator_id', 'updated_by_operator_id', 'created_at', 'updated_at',
].join(', ');

const OVERRIDE_SELECT = `
  SELECT override.*, workspace.name AS workspace_name
  FROM operator_feature_flag_overrides override
  JOIN workspaces workspace ON workspace.id = override.workspace_id
`;

function toOverride(row: OverrideRow): OperatorFeatureFlagOverride {
  return {
    id: Number(row.id),
    featureFlagId: Number(row.feature_flag_id),
    workspaceId: Number(row.workspace_id),
    workspaceName: row.workspace_name,
    enabled: truthy(row.enabled),
    reason: row.reason,
    active: truthy(row.active),
    revision: Number(row.revision),
    createdByOperatorId: Number(row.created_by_operator_id),
    updatedByOperatorId: Number(row.updated_by_operator_id),
    createdAt: databaseTimestamp(row.created_at),
    updatedAt: databaseTimestamp(row.updated_at),
  };
}

function toEvent(row: EventRow): OperatorFeatureFlagEvent {
  return {
    id: Number(row.id),
    eventId: row.event_id,
    featureFlagId: Number(row.feature_flag_id),
    operatorUserId: Number(row.operator_user_id),
    action: row.action,
    snapshot: parseObject(row.snapshot_json),
    createdAt: databaseTimestamp(row.created_at),
  };
}

function normalizeFlagKey(value: unknown): string {
  if (typeof value !== 'string') throw new Error('feature flag key is invalid');
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length < 3 || normalized.length > 80
    || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(normalized)
  ) throw new Error('feature flag key is invalid');
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

function truthy(value: boolean | number): boolean {
  return value === true || Number(value) === 1;
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
