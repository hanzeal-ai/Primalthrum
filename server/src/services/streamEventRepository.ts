import { SqliteDatabase, sqlValue } from '../db/sqlite';

export interface StreamEventRecord {
  id: number;
  runId: number;
  eventType: string;
  node: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface CreateStreamEventInput {
  runId: number;
  eventType: string;
  node?: string;
  payload: Record<string, unknown>;
}

interface StreamEventRow {
  id: number;
  run_id: number;
  event_type: string;
  node: string;
  payload_json: string;
  created_at: string;
}

interface NormalizedStreamEventInput {
  runId: number;
  eventType: string;
  node: string;
  payload: Record<string, unknown>;
}

export class StreamEventRepository {
  constructor(private readonly db: SqliteDatabase) {}

  create(input: CreateStreamEventInput): StreamEventRecord {
    const normalized = normalizeEventInput(input);

    this.db.run(`
      INSERT INTO stream_events (run_id, event_type, node, payload_json)
      VALUES (
        ${sqlValue(normalized.runId)},
        ${sqlValue(normalized.eventType)},
        ${sqlValue(normalized.node)},
        ${sqlValue(JSON.stringify(normalized.payload))}
      );
    `);

    const rows = this.db.query<StreamEventRow>(`
      SELECT id, run_id, event_type, node, payload_json, created_at
      FROM stream_events
      ORDER BY id DESC
      LIMIT 1;
    `);

    if (!rows[0]) {
      throw new Error('created stream event could not be loaded');
    }

    return toStreamEventRecord(rows[0]);
  }

  listByRunId(runId: number): StreamEventRecord[] {
    return this.db.query<StreamEventRow>(`
      SELECT id, run_id, event_type, node, payload_json, created_at
      FROM stream_events
      WHERE run_id = ${sqlValue(runId)}
      ORDER BY id ASC;
    `).map(toStreamEventRecord);
  }
}

function normalizeEventInput(input: CreateStreamEventInput): NormalizedStreamEventInput {
  const runId = Number(input.runId);
  if (!Number.isInteger(runId) || runId <= 0) {
    throw new Error('runId must be a positive integer');
  }

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
    createdAt: row.created_at,
  };
}
