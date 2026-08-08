import {
  type AsyncDatabaseAdapter,
  type AsyncDatabaseSession,
  type DatabaseParameter,
} from '../db/asyncAdapter';
import { databaseTimestamp, nullableDatabaseTimestamp } from '../db/databaseTimestamp';
import {
  type RetentionEventRecord,
  type RetentionFileDeletionRecord,
  type RetentionPolicyRecord,
  type RetentionPolicySnapshot,
  type RetentionPreview,
} from './retentionPolicyRepository';
import {
  type RetentionPolicyStore,
  type UpdateRetentionPolicyInput,
} from './retentionPolicyStore';

interface RetentionPolicyRow {
  workspace_id: number;
  conversation_days: number | null;
  run_days: number | null;
  document_days: number | null;
  updated_by_user_id: number | null;
  last_enforced_at: string | Date | null;
  next_enforcement_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface RetentionEventRow {
  id: number;
  workspace_id: number;
  event_type: RetentionEventRecord['eventType'];
  actor_user_id: number | null;
  policy_json: string;
  result_json: string;
  created_at: string | Date;
}

interface RetentionFileDeletionRow {
  id: number;
  workspace_id: number;
  storage_ref: string;
  attempts: number;
}

interface RetentionCondition {
  text: string;
  values: DatabaseParameter[];
}

const DAY_MS = 86_400_000;
const NEXT_ENFORCEMENT_MS = DAY_MS;

export class AsyncRetentionPolicyRepository implements RetentionPolicyStore {
  constructor(
    private readonly database: AsyncDatabaseAdapter,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async get(workspaceId: number): Promise<RetentionPolicyRecord> {
    await this.ensure(this.database, workspaceId);
    return this.load(this.database, workspaceId);
  }

  update(input: UpdateRetentionPolicyInput): Promise<RetentionPolicyRecord> {
    const snapshot: RetentionPolicySnapshot = {
      conversationDays: normalizeDays(input.conversationDays, 30, 'conversationDays'),
      runDays: normalizeDays(input.runDays, 7, 'runDays'),
      documentDays: normalizeDays(input.documentDays, 30, 'documentDays'),
    };
    const now = this.now().toISOString();
    const next = hasFiniteRetention(snapshot) ? now : null;
    return this.database.transaction(async (session) => {
      await this.ensure(session, input.workspaceId);
      await session.execute({
        text: `
          UPDATE workspace_retention_policies
          SET conversation_days = $2, run_days = $3, document_days = $4,
            updated_by_user_id = $5, next_enforcement_at = $6, updated_at = $7
          WHERE workspace_id = $1;
        `,
        values: [
          input.workspaceId,
          snapshot.conversationDays,
          snapshot.runDays,
          snapshot.documentDays,
          input.actorUserId,
          next,
          now,
        ],
      });
      await session.execute({
        text: `
          INSERT INTO retention_events (
            workspace_id, event_type, actor_user_id, policy_json, result_json, created_at
          ) VALUES ($1, 'policy_updated', $2, $3, '{}', $4);
        `,
        values: [input.workspaceId, input.actorUserId, JSON.stringify(snapshot), now],
      });
      return this.load(session, input.workspaceId);
    });
  }

  async preview(workspaceId: number): Promise<RetentionPreview> {
    return this.previewPolicy(workspaceId, snapshotOf(await this.get(workspaceId)));
  }

  previewPolicy(
    workspaceId: number,
    policy: RetentionPolicySnapshot,
  ): Promise<RetentionPreview> {
    return this.previewWithSession(this.database, workspaceId, policy, this.now());
  }

  enforce(workspaceId: number, actorUserId: number | null): Promise<RetentionEventRecord> {
    const now = this.now();
    const nowIso = now.toISOString();
    return this.database.transaction(async (session) => {
      await this.ensure(session, workspaceId);
      if (this.database.dialect === 'postgres') {
        await session.query({
          text: 'SELECT id FROM workspaces WHERE id = $1 FOR UPDATE;',
          values: [workspaceId],
        });
      }
      const policy = await this.load(session, workspaceId, true);
      const snapshot = snapshotOf(policy);
      const next = hasFiniteRetention(snapshot)
        ? new Date(now.getTime() + NEXT_ENFORCEMENT_MS).toISOString()
        : null;
      const holds = await session.query<{ count: number | string }>({
        text: `
          SELECT COUNT(*) AS count FROM workspace_legal_holds
          WHERE workspace_id = $1 AND status = 'active';
        `,
        values: [workspaceId],
      });
      const legalHoldCount = Number(holds[0]?.count ?? 0);
      if (legalHoldCount > 0) {
        const event = await this.insertEvent(session, {
          workspaceId,
          actorUserId,
          eventType: 'enforcement_blocked',
          snapshot,
          result: { legalHoldCount },
          now: nowIso,
        });
        await this.updateEnforcementTime(session, workspaceId, null, next, nowIso);
        return event;
      }

      const preview = await this.previewWithSession(session, workspaceId, snapshot, now);
      const documentCondition = this.condition('created_at', snapshot.documentDays, now, 2);
      const runCondition = this.condition(
        'COALESCE(ended_at, started_at)', snapshot.runDays, now, 2,
      );
      const conversationCondition = this.condition('updated_at', snapshot.conversationDays, now, 2);
      const runArchiveTimestamp = 2 + runCondition.values.length;
      const jobCompletionTimestamp = 2 + documentCondition.values.length;
      const queuedFiles = await session.query<{ count: number | string }>({
        text: `
          SELECT COUNT(*) AS count FROM documents
          WHERE workspace_id = $1 AND ${documentCondition.text} AND storage_ref <> '';
        `,
        values: [workspaceId, ...documentCondition.values],
      });
      const result = {
        ...preview,
        filesQueued: Number(queuedFiles[0]?.count ?? 0),
      };
      const event = await this.insertEvent(session, {
        workspaceId,
        actorUserId,
        eventType: 'enforcement_completed',
        snapshot,
        result,
        now: nowIso,
      });

      await session.execute({
        text: `
          INSERT INTO retained_tool_audit_logs (
            original_audit_id, workspace_id, run_id, event_id, tool_name, status,
            dangerous, node, payload_json, created_at, archived_at
          )
          SELECT id, workspace_id, run_id, event_id, tool_name, status,
            dangerous, node, payload_json, created_at, $${runArchiveTimestamp}
          FROM tool_audit_logs
          WHERE workspace_id = $1 AND run_id IN (
            SELECT id FROM runs
            WHERE workspace_id = $1 AND ${runCondition.text}
              AND status NOT IN ('pending', 'running')
          )
          ON CONFLICT(original_audit_id) DO NOTHING;
        `,
        values: [workspaceId, ...runCondition.values, nowIso],
      });
      await session.execute({
        text: `
          INSERT INTO retention_file_deletions (workspace_id, storage_ref)
          SELECT workspace_id, storage_ref FROM documents
          WHERE workspace_id = $1 AND ${documentCondition.text} AND storage_ref <> ''
          ON CONFLICT(storage_ref) DO NOTHING;
        `,
        values: [workspaceId, ...documentCondition.values],
      });
      const documentIdExpression = this.database.dialect === 'postgres'
        ? "CAST(payload_json::jsonb ->> 'documentId' AS INTEGER)"
        : "CAST(json_extract(payload_json, '$.documentId') AS INTEGER)";
      await session.execute({
        text: `
          UPDATE jobs SET status = 'failed', error = 'document removed by retention policy',
            completed_at = $${jobCompletionTimestamp}, updated_at = $${jobCompletionTimestamp}
          WHERE workspace_id = $1 AND type = 'document.index'
            AND status IN ('queued', 'retrying')
            AND ${documentIdExpression} IN (
              SELECT id FROM documents
              WHERE workspace_id = $1 AND ${documentCondition.text}
            );
        `,
        values: [workspaceId, ...documentCondition.values, nowIso],
      });
      await session.execute({
        text: `
          UPDATE runs SET conversation_id = NULL
          WHERE workspace_id = $1 AND conversation_id IN (
            SELECT id FROM conversations
            WHERE workspace_id = $1 AND ${conversationCondition.text}
          );
        `,
        values: [workspaceId, ...conversationCondition.values],
      });
      await session.execute({
        text: `DELETE FROM conversations WHERE workspace_id = $1 AND ${conversationCondition.text};`,
        values: [workspaceId, ...conversationCondition.values],
      });
      await session.execute({
        text: `
          DELETE FROM runs WHERE workspace_id = $1 AND ${runCondition.text}
            AND status NOT IN ('pending', 'running');
        `,
        values: [workspaceId, ...runCondition.values],
      });
      await session.execute({
        text: `DELETE FROM documents WHERE workspace_id = $1 AND ${documentCondition.text};`,
        values: [workspaceId, ...documentCondition.values],
      });
      await this.updateEnforcementTime(session, workspaceId, nowIso, next, nowIso);
      return event;
    });
  }

  async listEvents(workspaceId: number, limit = 20): Promise<RetentionEventRecord[]> {
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = await this.database.query<RetentionEventRow>({
      text: `
        SELECT ${EVENT_COLUMNS} FROM retention_events
        WHERE workspace_id = $1 ORDER BY id DESC LIMIT $2;
      `,
      values: [workspaceId, boundedLimit],
    });
    return rows.map(toEvent);
  }

  async dueWorkspaceIds(): Promise<number[]> {
    const due = this.database.dialect === 'postgres'
      ? 'next_enforcement_at <= $1'
      : 'datetime(next_enforcement_at) <= datetime($1)';
    const rows = await this.database.query<{ workspace_id: number }>({
      text: `
        SELECT workspace_id FROM workspace_retention_policies
        WHERE next_enforcement_at IS NOT NULL AND ${due}
        ORDER BY workspace_id;
      `,
      values: [this.now().toISOString()],
    });
    return rows.map((row) => Number(row.workspace_id));
  }

  async pendingFileDeletions(
    workspaceId: number,
    limit = 100,
  ): Promise<RetentionFileDeletionRecord[]> {
    const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = await this.database.query<RetentionFileDeletionRow>({
      text: `
        SELECT id, workspace_id, storage_ref, attempts
        FROM retention_file_deletions deletion
        WHERE workspace_id = $1 AND status IN ('pending', 'retrying')
          AND NOT EXISTS (
            SELECT 1 FROM workspace_legal_holds hold
            WHERE hold.workspace_id = deletion.workspace_id AND hold.status = 'active'
          )
        ORDER BY id LIMIT $2;
      `,
      values: [workspaceId, boundedLimit],
    });
    return rows.map((row) => ({
      id: Number(row.id),
      workspaceId: Number(row.workspace_id),
      storageRef: row.storage_ref,
      attempts: Number(row.attempts),
    }));
  }

  async hasActiveLegalHold(workspaceId: number): Promise<boolean> {
    const rows = await this.database.query<{ active: boolean | number }>({
      text: `
        SELECT EXISTS(
          SELECT 1 FROM workspace_legal_holds
          WHERE workspace_id = $1 AND status = 'active'
        ) AS active;
      `,
      values: [workspaceId],
    });
    return rows[0]?.active === true || Number(rows[0]?.active ?? 0) === 1;
  }

  async completeFileDeletion(id: number): Promise<void> {
    await this.database.execute({
      text: `
        UPDATE retention_file_deletions
        SET status = 'completed', attempts = attempts + 1, error = '',
          completed_at = $2, updated_at = $2
        WHERE id = $1;
      `,
      values: [id, this.now().toISOString()],
    });
  }

  async failFileDeletion(id: number, attempts: number, error: string): Promise<void> {
    const nextAttempts = attempts + 1;
    await this.database.execute({
      text: `
        UPDATE retention_file_deletions
        SET status = $2, attempts = $3, error = $4, updated_at = $5
        WHERE id = $1;
      `,
      values: [
        id,
        nextAttempts >= 3 ? 'failed' : 'retrying',
        nextAttempts,
        error.slice(0, 500),
        this.now().toISOString(),
      ],
    });
  }

  private async ensure(session: AsyncDatabaseSession, workspaceId: number): Promise<void> {
    await session.execute({
      text: `
        INSERT INTO workspace_retention_policies (workspace_id) VALUES ($1)
        ON CONFLICT(workspace_id) DO NOTHING;
      `,
      values: [workspaceId],
    });
  }

  private async load(
    session: AsyncDatabaseSession,
    workspaceId: number,
    lock = false,
  ): Promise<RetentionPolicyRecord> {
    const rows = await session.query<RetentionPolicyRow>({
      text: `
        SELECT ${POLICY_COLUMNS} FROM workspace_retention_policies
        WHERE workspace_id = $1 LIMIT 1
        ${lock && this.database.dialect === 'postgres' ? 'FOR UPDATE' : ''};
      `,
      values: [workspaceId],
    });
    if (!rows[0]) throw new Error('retention policy could not be loaded');
    return toPolicy(rows[0]);
  }

  private async previewWithSession(
    session: AsyncDatabaseSession,
    workspaceId: number,
    policy: RetentionPolicySnapshot,
    now: Date,
  ): Promise<RetentionPreview> {
    const values: DatabaseParameter[] = [workspaceId];
    const condition = (column: string, days: number | null): string => {
      const built = this.condition(column, days, now, values.length + 1);
      values.push(...built.values);
      return built.text;
    };
    const conversations = condition('updated_at', policy.conversationDays);
    const runs = condition('COALESCE(ended_at, started_at)', policy.runDays);
    const documents = condition('created_at', policy.documentDays);
    const rows = await session.query<{
      conversations: number | string;
      runs: number | string;
      documents: number | string;
      document_bytes: number | string;
    }>({
      text: `
        SELECT
          (SELECT COUNT(*) FROM conversations
            WHERE workspace_id = $1 AND ${conversations}) AS conversations,
          (SELECT COUNT(*) FROM runs
            WHERE workspace_id = $1 AND ${runs}
              AND status NOT IN ('pending', 'running')) AS runs,
          (SELECT COUNT(*) FROM documents
            WHERE workspace_id = $1 AND ${documents}) AS documents,
          (SELECT COALESCE(SUM(size_bytes), 0) FROM documents
            WHERE workspace_id = $1 AND ${documents}) AS document_bytes;
      `,
      values,
    });
    return {
      conversations: Number(rows[0]?.conversations ?? 0),
      runs: Number(rows[0]?.runs ?? 0),
      documents: Number(rows[0]?.documents ?? 0),
      documentBytes: Number(rows[0]?.document_bytes ?? 0),
    };
  }

  private condition(
    column: string,
    days: number | null,
    now: Date,
    placeholder: number,
  ): RetentionCondition {
    if (days === null) return { text: this.database.dialect === 'postgres' ? 'FALSE' : '0', values: [] };
    const cutoff = new Date(now.getTime() - days * DAY_MS).toISOString();
    return {
      text: this.database.dialect === 'postgres'
        ? `${column} < $${placeholder}`
        : `datetime(${column}) < datetime($${placeholder})`,
      values: [cutoff],
    };
  }

  private async insertEvent(
    session: AsyncDatabaseSession,
    input: {
      workspaceId: number;
      actorUserId: number | null;
      eventType: RetentionEventRecord['eventType'];
      snapshot: RetentionPolicySnapshot;
      result: Record<string, unknown>;
      now: string;
    },
  ): Promise<RetentionEventRecord> {
    const rows = await session.query<RetentionEventRow>({
      text: `
        INSERT INTO retention_events (
          workspace_id, event_type, actor_user_id, policy_json, result_json, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING ${EVENT_COLUMNS};
      `,
      values: [
        input.workspaceId,
        input.eventType,
        input.actorUserId,
        JSON.stringify(input.snapshot),
        JSON.stringify(input.result),
        input.now,
      ],
    });
    if (!rows[0]) throw new Error('retention enforcement event could not be loaded');
    return toEvent(rows[0]);
  }

  private async updateEnforcementTime(
    session: AsyncDatabaseSession,
    workspaceId: number,
    lastEnforcedAt: string | null,
    nextEnforcementAt: string | null,
    updatedAt: string,
  ): Promise<void> {
    await session.execute({
      text: `
        UPDATE workspace_retention_policies
        SET last_enforced_at = COALESCE($2, last_enforced_at),
          next_enforcement_at = $3, updated_at = $4
        WHERE workspace_id = $1;
      `,
      values: [workspaceId, lastEnforcedAt, nextEnforcementAt, updatedAt],
    });
  }
}

function normalizeDays(value: unknown, minimum: number, field: string): number | null {
  if (value === null) return null;
  const days = Number(value);
  if (!Number.isInteger(days) || days < minimum || days > 3650) {
    throw new Error(`${field} must be null or between ${minimum} and 3650 days`);
  }
  return days;
}

function hasFiniteRetention(policy: RetentionPolicySnapshot): boolean {
  return Object.values(policy).some((value) => value !== null);
}

function snapshotOf(policy: RetentionPolicyRecord): RetentionPolicySnapshot {
  return {
    conversationDays: policy.conversationDays,
    runDays: policy.runDays,
    documentDays: policy.documentDays,
  };
}

function toPolicy(row: RetentionPolicyRow): RetentionPolicyRecord {
  return {
    workspaceId: Number(row.workspace_id),
    conversationDays: nullableNumber(row.conversation_days),
    runDays: nullableNumber(row.run_days),
    documentDays: nullableNumber(row.document_days),
    updatedByUserId: nullableNumber(row.updated_by_user_id),
    lastEnforcedAt: nullableDatabaseTimestamp(row.last_enforced_at),
    nextEnforcementAt: nullableDatabaseTimestamp(row.next_enforcement_at),
    createdAt: databaseTimestamp(row.created_at),
    updatedAt: databaseTimestamp(row.updated_at),
  };
}

function toEvent(row: RetentionEventRow): RetentionEventRecord {
  return {
    id: Number(row.id),
    workspaceId: Number(row.workspace_id),
    eventType: row.event_type,
    actorUserId: nullableNumber(row.actor_user_id),
    policy: JSON.parse(row.policy_json) as RetentionPolicySnapshot,
    result: JSON.parse(row.result_json) as Record<string, unknown>,
    createdAt: databaseTimestamp(row.created_at),
  };
}

function nullableNumber(value: number | null): number | null {
  return value === null ? null : Number(value);
}

const POLICY_COLUMNS = [
  'workspace_id', 'conversation_days', 'run_days', 'document_days',
  'updated_by_user_id', 'last_enforced_at', 'next_enforcement_at',
  'created_at', 'updated_at',
].join(', ');

const EVENT_COLUMNS = [
  'id', 'workspace_id', 'event_type', 'actor_user_id',
  'policy_json', 'result_json', 'created_at',
].join(', ');
