import { type AsyncDatabaseAdapter } from '../db/asyncAdapter';
import { databaseTimestamp } from '../db/databaseTimestamp';
import {
  type CreateStreamEventInput,
  type StreamEventRecord,
} from './streamEventRepository';

interface StreamEventRow {
  id: number;
  run_id: number;
  event_type: string;
  node: string;
  payload_json: string;
  created_at: string | Date;
}

function normalizeEventInput(input: CreateStreamEventInput) {
  const runId = Number(input.runId);
  if (!Number.isInteger(runId) || runId <= 0) throw new Error('runId must be a positive integer');
  if (typeof input.eventType !== 'string' || !input.eventType.trim()) {
    throw new Error('eventType is required');
  }
  if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) {
    throw new Error('payload must be an object');
  }
  return {
    runId,
    eventType: input.eventType.trim(),
    node: typeof input.node === 'string' ? input.node.trim() : '',
    payload: input.payload,
  };
}

function toStreamEventRecord(row: StreamEventRow): StreamEventRecord {
  return {
    id: Number(row.id),
    runId: Number(row.run_id),
    eventType: row.event_type,
    node: row.node,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    createdAt: databaseTimestamp(row.created_at),
  };
}

export class AsyncStreamEventRepository {
  constructor(private readonly database: AsyncDatabaseAdapter) {}

  async create(input: CreateStreamEventInput): Promise<StreamEventRecord> {
    const normalized = normalizeEventInput(input);
    const rows = await this.database.query<StreamEventRow>({
      text: `
        INSERT INTO stream_events (run_id, event_type, node, payload_json)
        VALUES ($1, $2, $3, $4)
        RETURNING id, run_id, event_type, node, payload_json, created_at;
      `,
      values: [
        normalized.runId,
        normalized.eventType,
        normalized.node,
        JSON.stringify(normalized.payload),
      ],
    });
    if (!rows[0]) throw new Error('created stream event could not be loaded');
    return toStreamEventRecord(rows[0]);
  }

  listByRunId(runId: number): Promise<StreamEventRecord[]> {
    return this.listByRunIdAfter(runId);
  }

  async listByRunIdAfter(runId: number, afterEventId = 0): Promise<StreamEventRecord[]> {
    const rows = await this.database.query<StreamEventRow>({
      text: `
        SELECT id, run_id, event_type, node, payload_json, created_at
        FROM stream_events WHERE run_id = $1 AND id > $2 ORDER BY id ASC;
      `,
      values: [runId, afterEventId],
    });
    return rows.map(toStreamEventRecord);
  }
}
