import { type DatabaseAdapter } from '../db/adapter';
import { sqlValue } from '../db/sql';
import { type StreamEventRecord } from './streamEventRepository';

const TOOL_EVENT_PREFIX = 'agent.tool.';

export interface ToolAuditRecord {
  id: number;
  workspaceId: number;
  runId: number;
  eventId: number;
  toolName: string;
  status: string;
  dangerous: boolean;
  node: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

interface ToolAuditRow {
  id: number;
  workspace_id: number;
  run_id: number;
  event_id: number;
  tool_name: string;
  status: string;
  dangerous: number;
  node: string;
  payload_json: string;
  created_at: string;
}

interface RunWorkspaceRow {
  workspace_id: number;
}

export class ToolAuditRepository {
  constructor(private readonly db: DatabaseAdapter) {
  }

  recordStreamEvent(event: StreamEventRecord): ToolAuditRecord | null {
    if (!event.eventType.startsWith(TOOL_EVENT_PREFIX)) {
      return null;
    }

    const toolName = toolNameFromPayload(event.payload);
    if (!toolName) {
      return null;
    }

    const workspaceId = this.workspaceIdForRun(event.runId);
    const status = statusFromEvent(event);
    const dangerous = event.payload.dangerous === true;

    this.db.run(`
      INSERT OR IGNORE INTO tool_audit_logs (
        workspace_id,
        run_id,
        event_id,
        tool_name,
        status,
        dangerous,
        node,
        payload_json
      )
      VALUES (
        ${sqlValue(workspaceId)},
        ${sqlValue(event.runId)},
        ${sqlValue(event.id)},
        ${sqlValue(toolName)},
        ${sqlValue(status)},
        ${sqlValue(dangerous)},
        ${sqlValue(event.node)},
        ${sqlValue(JSON.stringify(event.payload))}
      );
    `);

    return this.findByEventId(event.id);
  }

  list(workspaceId: number, runId?: number): ToolAuditRecord[] {
    const runClause = typeof runId === 'number'
      ? `AND run_id = ${sqlValue(runId)}`
      : '';

    return this.db.query<ToolAuditRow>(`
      SELECT id, workspace_id, run_id, event_id, tool_name, status,
        dangerous, node, payload_json, created_at
      FROM (
        SELECT id, workspace_id, run_id, event_id, tool_name, status,
          dangerous, node, payload_json, created_at
        FROM tool_audit_logs
        WHERE workspace_id = ${sqlValue(workspaceId)} ${runClause}
        UNION ALL
        SELECT original_audit_id AS id, workspace_id, run_id, event_id,
          tool_name, status, dangerous, node, payload_json, created_at
        FROM retained_tool_audit_logs
        WHERE workspace_id = ${sqlValue(workspaceId)} ${runClause}
      )
      ORDER BY created_at ASC, event_id ASC;
    `).map(toToolAuditRecord);
  }

  private findByEventId(eventId: number): ToolAuditRecord | null {
    const rows = this.db.query<ToolAuditRow>(`
      SELECT
        id,
        workspace_id,
        run_id,
        event_id,
        tool_name,
        status,
        dangerous,
        node,
        payload_json,
        created_at
      FROM tool_audit_logs
      WHERE event_id = ${sqlValue(eventId)}
      LIMIT 1;
    `);
    return rows[0] ? toToolAuditRecord(rows[0]) : null;
  }

  private workspaceIdForRun(runId: number): number {
    const rows = this.db.query<RunWorkspaceRow>(`
      SELECT workspace_id
      FROM runs
      WHERE id = ${sqlValue(runId)}
      LIMIT 1;
    `);
    if (!rows[0]) {
      throw new Error(`run ${runId} not found`);
    }
    return Number(rows[0].workspace_id);
  }
}

function toolNameFromPayload(payload: Record<string, unknown>): string {
  const candidate = payload.tool ?? payload.toolName ?? payload.tool_name;
  return typeof candidate === 'string' ? candidate.trim() : '';
}

function statusFromEvent(event: StreamEventRecord): string {
  if (typeof event.payload.status === 'string' && event.payload.status.trim()) {
    return event.payload.status.trim();
  }
  return event.eventType.replace(TOOL_EVENT_PREFIX, '') || 'called';
}

function toToolAuditRecord(row: ToolAuditRow): ToolAuditRecord {
  return {
    id: Number(row.id),
    workspaceId: Number(row.workspace_id),
    runId: Number(row.run_id),
    eventId: Number(row.event_id),
    toolName: row.tool_name,
    status: row.status,
    dangerous: Number(row.dangerous) === 1,
    node: row.node,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}
