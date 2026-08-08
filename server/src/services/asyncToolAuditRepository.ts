import { type AsyncDatabaseAdapter } from '../db/asyncAdapter';
import { databaseTimestamp } from '../db/databaseTimestamp';
import { type StreamEventRecord } from './streamEventRepository';
import { type ToolAuditRecord } from './toolAuditRepository';

const TOOL_EVENT_PREFIX = 'agent.tool.';

interface ToolAuditRow {
  id: number;
  workspace_id: number;
  run_id: number;
  event_id: number;
  tool_name: string;
  status: string;
  dangerous: boolean | number;
  node: string;
  payload_json: string;
  created_at: string | Date;
}

const TOOL_AUDIT_COLUMNS = [
  'id', 'workspace_id', 'run_id', 'event_id', 'tool_name', 'status',
  'dangerous', 'node', 'payload_json', 'created_at',
].join(', ');

export class AsyncToolAuditRepository {
  constructor(private readonly database: AsyncDatabaseAdapter) {}

  async recordStreamEvent(event: StreamEventRecord): Promise<ToolAuditRecord | null> {
    if (!event.eventType.startsWith(TOOL_EVENT_PREFIX)) return null;
    const toolName = toolNameFromPayload(event.payload);
    if (!toolName) return null;

    const rows = await this.database.query<ToolAuditRow>({
      text: `
        INSERT INTO tool_audit_logs (
          workspace_id, run_id, event_id, tool_name, status, dangerous, node, payload_json
        )
        SELECT workspace_id, id, $2, $3, $4, $5, $6, $7
        FROM runs WHERE id = $1
        ON CONFLICT(event_id) DO NOTHING
        RETURNING ${TOOL_AUDIT_COLUMNS};
      `,
      values: [
        event.runId,
        event.id,
        toolName,
        statusFromEvent(event),
        event.payload.dangerous === true,
        event.node,
        JSON.stringify(event.payload),
      ],
    });
    if (rows[0]) return toToolAuditRecord(rows[0]);
    const existing = await this.findByEventId(event.id);
    if (existing) return existing;
    throw new Error(`run ${event.runId} not found`);
  }

  async list(workspaceId: number, runId?: number): Promise<ToolAuditRecord[]> {
    const values = typeof runId === 'number' ? [workspaceId, runId] : [workspaceId];
    const runClause = typeof runId === 'number' ? 'AND run_id = $2' : '';
    const rows = await this.database.query<ToolAuditRow>({
      text: `
        SELECT ${TOOL_AUDIT_COLUMNS}
        FROM (
          SELECT ${TOOL_AUDIT_COLUMNS}
          FROM tool_audit_logs
          WHERE workspace_id = $1 ${runClause}
          UNION ALL
          SELECT original_audit_id AS id, workspace_id, run_id, event_id,
            tool_name, status, dangerous, node, payload_json, created_at
          FROM retained_tool_audit_logs
          WHERE workspace_id = $1 ${runClause}
        ) AS audit_records
        ORDER BY created_at ASC, event_id ASC;
      `,
      values,
    });
    return rows.map(toToolAuditRecord);
  }

  private async findByEventId(eventId: number): Promise<ToolAuditRecord | null> {
    const rows = await this.database.query<ToolAuditRow>({
      text: `
        SELECT ${TOOL_AUDIT_COLUMNS} FROM tool_audit_logs
        WHERE event_id = $1 LIMIT 1;
      `,
      values: [eventId],
    });
    return rows[0] ? toToolAuditRecord(rows[0]) : null;
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
    dangerous: Boolean(row.dangerous),
    node: row.node,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    createdAt: databaseTimestamp(row.created_at),
  };
}
