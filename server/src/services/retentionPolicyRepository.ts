import { initializeSchema } from '../db/schema';
import { type DatabaseAdapter } from '../db/adapter';
import { sqlValue } from '../db/sql';

export interface RetentionPolicyRecord {
  workspaceId: number;
  conversationDays: number | null;
  runDays: number | null;
  documentDays: number | null;
  updatedByUserId: number | null;
  lastEnforcedAt: string | null;
  nextEnforcementAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RetentionPreview {
  conversations: number;
  runs: number;
  documents: number;
  documentBytes: number;
}

export interface RetentionEnforcementResult extends RetentionPreview {
  filesQueued: number;
}

export interface RetentionEventRecord {
  id: number;
  workspaceId: number;
  eventType: 'policy_updated' | 'enforcement_completed' | 'enforcement_blocked';
  actorUserId: number | null;
  policy: RetentionPolicySnapshot;
  result: Record<string, unknown>;
  createdAt: string;
}

export interface RetentionFileDeletionRecord {
  id: number;
  workspaceId: number;
  storageRef: string;
  attempts: number;
}

export interface RetentionPolicySnapshot {
  conversationDays: number | null;
  runDays: number | null;
  documentDays: number | null;
}

interface RetentionPolicyRow {
  workspace_id: number;
  conversation_days: number | null;
  run_days: number | null;
  document_days: number | null;
  updated_by_user_id: number | null;
  last_enforced_at: string | null;
  next_enforcement_at: string | null;
  created_at: string;
  updated_at: string;
}

interface RetentionEventRow {
  id: number;
  workspace_id: number;
  event_type: RetentionEventRecord['eventType'];
  actor_user_id: number | null;
  policy_json: string;
  result_json: string;
  created_at: string;
}

interface RetentionFileDeletionRow {
  id: number;
  workspace_id: number;
  storage_ref: string;
  attempts: number;
}

const DAY_MS = 86_400_000;
const NEXT_ENFORCEMENT_MS = DAY_MS;

export class RetentionPolicyRepository {
  constructor(
    private readonly db: DatabaseAdapter,
    private readonly now: () => Date = () => new Date(),
  ) {
    initializeSchema(db);
  }

  get(workspaceId: number): RetentionPolicyRecord {
    this.ensure(workspaceId);
    const row = this.db.query<RetentionPolicyRow>(`
      SELECT ${POLICY_COLUMNS}
      FROM workspace_retention_policies
      WHERE workspace_id = ${sqlValue(workspaceId)}
      LIMIT 1;
    `)[0];
    if (!row) throw new Error('retention policy could not be loaded');
    return toPolicy(row);
  }

  update(input: {
    workspaceId: number;
    conversationDays: unknown;
    runDays: unknown;
    documentDays: unknown;
    actorUserId: number;
  }): RetentionPolicyRecord {
    const snapshot: RetentionPolicySnapshot = {
      conversationDays: normalizeDays(input.conversationDays, 30, 'conversationDays'),
      runDays: normalizeDays(input.runDays, 7, 'runDays'),
      documentDays: normalizeDays(input.documentDays, 30, 'documentDays'),
    };
    this.ensure(input.workspaceId);
    const now = this.now().toISOString();
    const next = hasFiniteRetention(snapshot) ? now : null;
    this.db.run(`
      PRAGMA foreign_keys = ON;
      BEGIN IMMEDIATE;
      UPDATE workspace_retention_policies
      SET conversation_days = ${sqlValue(snapshot.conversationDays)},
        run_days = ${sqlValue(snapshot.runDays)},
        document_days = ${sqlValue(snapshot.documentDays)},
        updated_by_user_id = ${sqlValue(input.actorUserId)},
        next_enforcement_at = ${sqlValue(next)},
        updated_at = ${sqlValue(now)}
      WHERE workspace_id = ${sqlValue(input.workspaceId)};

      INSERT INTO retention_events (
        workspace_id, event_type, actor_user_id, policy_json, result_json, created_at
      ) VALUES (
        ${sqlValue(input.workspaceId)}, 'policy_updated', ${sqlValue(input.actorUserId)},
        ${sqlValue(JSON.stringify(snapshot))}, '{}', ${sqlValue(now)}
      );
      COMMIT;
    `);
    return this.get(input.workspaceId);
  }

  preview(workspaceId: number): RetentionPreview {
    return this.previewPolicy(workspaceId, snapshotOf(this.get(workspaceId)));
  }

  previewPolicy(workspaceId: number, policy: RetentionPolicySnapshot): RetentionPreview {
    const conditions = retentionConditions(policy, this.now());
    const row = this.db.query<{
      conversations: number;
      runs: number;
      documents: number;
      document_bytes: number;
    }>(`
      SELECT
        (SELECT COUNT(*) FROM conversations
          WHERE workspace_id = ${sqlValue(workspaceId)} AND ${conditions.conversations})
          AS conversations,
        (SELECT COUNT(*) FROM runs
          WHERE workspace_id = ${sqlValue(workspaceId)} AND ${conditions.runs}) AS runs,
        (SELECT COUNT(*) FROM documents
          WHERE workspace_id = ${sqlValue(workspaceId)} AND ${conditions.documents}) AS documents,
        (SELECT COALESCE(SUM(size_bytes), 0) FROM documents
          WHERE workspace_id = ${sqlValue(workspaceId)} AND ${conditions.documents})
          AS document_bytes;
    `)[0];
    return {
      conversations: Number(row?.conversations ?? 0),
      runs: Number(row?.runs ?? 0),
      documents: Number(row?.documents ?? 0),
      documentBytes: Number(row?.document_bytes ?? 0),
    };
  }

  enforce(workspaceId: number, actorUserId: number | null): RetentionEventRecord {
    const policy = this.get(workspaceId);
    const snapshot = snapshotOf(policy);
    const now = this.now();
    const nowIso = now.toISOString();
    const next = hasFiniteRetention(snapshot)
      ? new Date(now.getTime() + NEXT_ENFORCEMENT_MS).toISOString()
      : null;
    const conditions = retentionConditions(snapshot, now);
    const policyJson = JSON.stringify(snapshot);
    const activeHoldCount = `(SELECT COUNT(*) FROM workspace_legal_holds
      WHERE workspace_id = ${sqlValue(workspaceId)} AND status = 'active')`;
    const noActiveHold = `NOT EXISTS (SELECT 1 FROM workspace_legal_holds
      WHERE workspace_id = ${sqlValue(workspaceId)} AND status = 'active')`;

    this.db.run(`
      PRAGMA foreign_keys = ON;
      BEGIN IMMEDIATE;
      INSERT INTO retention_events (
        workspace_id, event_type, actor_user_id, policy_json, result_json, created_at
      )
      SELECT ${sqlValue(workspaceId)},
        CASE WHEN ${activeHoldCount} > 0
          THEN 'enforcement_blocked' ELSE 'enforcement_completed' END,
        ${sqlValue(actorUserId)}, ${sqlValue(policyJson)},
        CASE WHEN ${activeHoldCount} > 0 THEN json_object(
          'legalHoldCount', ${activeHoldCount}
        ) ELSE json_object(
          'conversations', (SELECT COUNT(*) FROM conversations
            WHERE workspace_id = ${sqlValue(workspaceId)} AND ${conditions.conversations}),
          'runs', (SELECT COUNT(*) FROM runs
            WHERE workspace_id = ${sqlValue(workspaceId)} AND ${conditions.runs}),
          'documents', (SELECT COUNT(*) FROM documents
            WHERE workspace_id = ${sqlValue(workspaceId)} AND ${conditions.documents}),
          'documentBytes', (SELECT COALESCE(SUM(size_bytes), 0) FROM documents
            WHERE workspace_id = ${sqlValue(workspaceId)} AND ${conditions.documents}),
          'filesQueued', (SELECT COUNT(*) FROM documents
            WHERE workspace_id = ${sqlValue(workspaceId)}
              AND ${conditions.documents} AND storage_ref <> '')
        ) END, ${sqlValue(nowIso)};

      INSERT OR IGNORE INTO retained_tool_audit_logs (
        original_audit_id, workspace_id, run_id, event_id, tool_name, status,
        dangerous, node, payload_json, created_at, archived_at
      )
      SELECT id, workspace_id, run_id, event_id, tool_name, status,
        dangerous, node, payload_json, created_at, ${sqlValue(nowIso)}
      FROM tool_audit_logs
      WHERE workspace_id = ${sqlValue(workspaceId)}
        AND ${noActiveHold}
        AND run_id IN (
          SELECT id FROM runs
          WHERE workspace_id = ${sqlValue(workspaceId)} AND ${conditions.runs}
        );

      INSERT OR IGNORE INTO retention_file_deletions (workspace_id, storage_ref)
      SELECT workspace_id, storage_ref
      FROM documents
      WHERE workspace_id = ${sqlValue(workspaceId)}
        AND ${noActiveHold}
        AND ${conditions.documents}
        AND storage_ref <> '';

      UPDATE jobs
      SET status = 'failed', error = 'document removed by retention policy',
        completed_at = ${sqlValue(nowIso)}, updated_at = ${sqlValue(nowIso)}
      WHERE workspace_id = ${sqlValue(workspaceId)}
        AND ${noActiveHold}
        AND type = 'document.index'
        AND status IN ('queued', 'retrying')
        AND CAST(json_extract(payload_json, '$.documentId') AS INTEGER) IN (
          SELECT id FROM documents
          WHERE workspace_id = ${sqlValue(workspaceId)} AND ${conditions.documents}
        );

      UPDATE runs
      SET conversation_id = NULL
      WHERE workspace_id = ${sqlValue(workspaceId)}
        AND ${noActiveHold}
        AND conversation_id IN (
          SELECT id FROM conversations
          WHERE workspace_id = ${sqlValue(workspaceId)} AND ${conditions.conversations}
        );

      DELETE FROM conversations
      WHERE workspace_id = ${sqlValue(workspaceId)} AND ${noActiveHold}
        AND ${conditions.conversations};
      DELETE FROM runs
      WHERE workspace_id = ${sqlValue(workspaceId)} AND ${noActiveHold}
        AND ${conditions.runs};
      DELETE FROM documents
      WHERE workspace_id = ${sqlValue(workspaceId)} AND ${noActiveHold}
        AND ${conditions.documents};

      UPDATE workspace_retention_policies
      SET last_enforced_at = CASE WHEN ${noActiveHold}
          THEN ${sqlValue(nowIso)} ELSE last_enforced_at END,
        next_enforcement_at = ${sqlValue(next)},
        updated_at = ${sqlValue(nowIso)}
      WHERE workspace_id = ${sqlValue(workspaceId)};
      COMMIT;
    `);

    const event = this.db.query<RetentionEventRow>(`
      SELECT ${EVENT_COLUMNS}
      FROM retention_events
      WHERE workspace_id = ${sqlValue(workspaceId)}
        AND event_type IN ('enforcement_completed', 'enforcement_blocked')
      ORDER BY id DESC
      LIMIT 1;
    `)[0];
    if (!event) throw new Error('retention enforcement event could not be loaded');
    return toEvent(event);
  }

  listEvents(workspaceId: number, limit = 20): RetentionEventRecord[] {
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    return this.db.query<RetentionEventRow>(`
      SELECT ${EVENT_COLUMNS}
      FROM retention_events
      WHERE workspace_id = ${sqlValue(workspaceId)}
      ORDER BY id DESC
      LIMIT ${boundedLimit};
    `).map(toEvent);
  }

  dueWorkspaceIds(): number[] {
    return this.db.query<{ workspace_id: number }>(`
      SELECT workspace_id
      FROM workspace_retention_policies
      WHERE next_enforcement_at IS NOT NULL
        AND datetime(next_enforcement_at) <= datetime(${sqlValue(this.now().toISOString())})
      ORDER BY workspace_id;
    `).map((row) => Number(row.workspace_id));
  }

  pendingFileDeletions(workspaceId: number, limit = 100): RetentionFileDeletionRecord[] {
    const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    return this.db.query<RetentionFileDeletionRow>(`
      SELECT id, workspace_id, storage_ref, attempts
      FROM retention_file_deletions
      WHERE workspace_id = ${sqlValue(workspaceId)}
        AND status IN ('pending', 'retrying')
        AND NOT EXISTS (
          SELECT 1 FROM workspace_legal_holds hold
          WHERE hold.workspace_id = retention_file_deletions.workspace_id
            AND hold.status = 'active'
        )
      ORDER BY id
      LIMIT ${boundedLimit};
    `).map((row) => ({
      id: Number(row.id),
      workspaceId: Number(row.workspace_id),
      storageRef: row.storage_ref,
      attempts: Number(row.attempts),
    }));
  }

  hasActiveLegalHold(workspaceId: number): boolean {
    const row = this.db.query<{ active: number }>(`
      SELECT EXISTS(
        SELECT 1 FROM workspace_legal_holds
        WHERE workspace_id = ${sqlValue(workspaceId)} AND status = 'active'
      ) AS active;
    `)[0];
    return Number(row?.active ?? 0) === 1;
  }

  completeFileDeletion(id: number): void {
    this.db.run(`
      UPDATE retention_file_deletions
      SET status = 'completed', attempts = attempts + 1, error = '',
        completed_at = ${sqlValue(this.now().toISOString())}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ${sqlValue(id)};
    `);
  }

  failFileDeletion(id: number, attempts: number, error: string): void {
    const nextAttempts = attempts + 1;
    this.db.run(`
      UPDATE retention_file_deletions
      SET status = ${sqlValue(nextAttempts >= 3 ? 'failed' : 'retrying')},
        attempts = ${sqlValue(nextAttempts)}, error = ${sqlValue(error.slice(0, 500))},
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${sqlValue(id)};
    `);
  }

  private ensure(workspaceId: number): void {
    this.db.run(`
      INSERT OR IGNORE INTO workspace_retention_policies (workspace_id)
      VALUES (${sqlValue(workspaceId)});
    `);
  }
}

function retentionConditions(policy: RetentionPolicySnapshot, now: Date): {
  conversations: string;
  runs: string;
  documents: string;
} {
  return {
    conversations: cutoffCondition('updated_at', policy.conversationDays, now),
    runs: policy.runDays === null
      ? '0'
      : `${cutoffCondition('COALESCE(ended_at, started_at)', policy.runDays, now)}
        AND status NOT IN ('pending', 'running')`,
    documents: cutoffCondition('created_at', policy.documentDays, now),
  };
}

function cutoffCondition(column: string, days: number | null, now: Date): string {
  if (days === null) return '0';
  const cutoff = new Date(now.getTime() - days * DAY_MS).toISOString();
  return `datetime(${column}) < datetime(${sqlValue(cutoff)})`;
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
    lastEnforcedAt: row.last_enforced_at,
    nextEnforcementAt: row.next_enforcement_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
    createdAt: row.created_at,
  };
}

function nullableNumber(value: number | null): number | null {
  return value === null ? null : Number(value);
}

const POLICY_COLUMNS = [
  'workspace_id',
  'conversation_days',
  'run_days',
  'document_days',
  'updated_by_user_id',
  'last_enforced_at',
  'next_enforcement_at',
  'created_at',
  'updated_at',
].join(', ');

const EVENT_COLUMNS = [
  'id',
  'workspace_id',
  'event_type',
  'actor_user_id',
  'policy_json',
  'result_json',
  'created_at',
].join(', ');
