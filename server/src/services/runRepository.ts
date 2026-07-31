import { SqliteDatabase, sqlValue } from '../db/sqlite';

export interface RunRecord {
  id: number;
  agentId: number;
  agentVersionId: number | null;
  idempotencyKey: string | null;
  requestHash: string;
  conversationId: number | null;
  workspaceId: number;
  input: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
}

export interface CreateRunInput {
  agentId: number;
  input: string;
  agentVersionId?: number | null;
  idempotencyKey?: string | null;
  requestHash?: string;
}

interface RunRow {
  id: number;
  agent_id: number;
  agent_version_id: number | null;
  idempotency_key: string | null;
  request_hash: string;
  conversation_id: number | null;
  workspace_id: number;
  input: string;
  status: string;
  started_at: string;
  ended_at: string | null;
}

export class RunRepository {
  constructor(private readonly db: SqliteDatabase) {}

  create(input: CreateRunInput): RunRecord {
    const normalized = normalizeRunInput(input);

    this.db.run(`
      INSERT INTO runs (
        agent_id,
        agent_version_id,
        workspace_id,
        input,
        status,
        idempotency_key,
        request_hash
      )
      VALUES (
        ${sqlValue(normalized.agentId)},
        ${sqlValue(normalized.agentVersionId ?? null)},
        (
          SELECT workspace_id
          FROM agents
          WHERE id = ${sqlValue(normalized.agentId)}
        ),
        ${sqlValue(normalized.input)},
        'pending',
        ${sqlValue(normalized.idempotencyKey ?? null)},
        ${sqlValue(normalized.requestHash ?? '')}
      );
    `);

    const rows = normalized.idempotencyKey
      ? this.db.query<RunRow>(`
          SELECT ${RUN_COLUMNS}
          FROM runs
          WHERE workspace_id = (
            SELECT workspace_id FROM agents WHERE id = ${sqlValue(normalized.agentId)}
          )
            AND idempotency_key = ${sqlValue(normalized.idempotencyKey)}
          LIMIT 1;
        `)
      : this.db.query<RunRow>(`
      SELECT ${RUN_COLUMNS}
      FROM runs
      ORDER BY id DESC
      LIMIT 1;
    `);

    if (!rows[0]) {
      throw new Error('created run could not be loaded');
    }

    return toRunRecord(rows[0]);
  }

  findById(id: number): RunRecord | null {
    const rows = this.db.query<RunRow>(`
      SELECT ${RUN_COLUMNS}
      FROM runs
      WHERE id = ${sqlValue(id)}
      LIMIT 1;
    `);
    return rows[0] ? toRunRecord(rows[0]) : null;
  }

  findByIdInWorkspace(id: number, workspaceId: number): RunRecord | null {
    const run = this.findById(id);
    return run?.workspaceId === workspaceId ? run : null;
  }

  findByIdempotencyKey(workspaceId: number, idempotencyKey: string): RunRecord | null {
    const rows = this.db.query<RunRow>(`
      SELECT ${RUN_COLUMNS}
      FROM runs
      WHERE workspace_id = ${sqlValue(workspaceId)}
        AND idempotency_key = ${sqlValue(idempotencyKey)}
      LIMIT 1;
    `);
    return rows[0] ? toRunRecord(rows[0]) : null;
  }

  attachConversation(id: number, conversationId: number): RunRecord {
    this.db.run(`
      UPDATE runs
      SET conversation_id = ${sqlValue(conversationId)}
      WHERE id = ${sqlValue(id)};
    `);
    const updated = this.findById(id);
    if (!updated) throw new Error(`run ${id} not found`);
    return updated;
  }

  updateStatus(id: number, status: string, endedAt: string | null = null): RunRecord {
    this.db.run(`
      UPDATE runs
      SET status = ${sqlValue(status)}, ended_at = ${sqlValue(endedAt)}
      WHERE id = ${sqlValue(id)};
    `);

    const updated = this.findById(id);
    if (!updated) {
      throw new Error(`run ${id} not found`);
    }
    return updated;
  }
}

function normalizeRunInput(input: CreateRunInput): CreateRunInput {
  const agentId = Number(input.agentId);
  if (!Number.isInteger(agentId) || agentId <= 0) {
    throw new Error('agentId must be a positive integer');
  }

  if (typeof input.input !== 'string' || !input.input.trim()) {
    throw new Error('run input is required');
  }

  return {
    agentId,
    input: input.input.trim(),
    agentVersionId: normalizeOptionalVersionId(input.agentVersionId),
    idempotencyKey: normalizeOptionalIdempotencyKey(input.idempotencyKey),
    requestHash: typeof input.requestHash === 'string' ? input.requestHash : '',
  };
}

function normalizeOptionalIdempotencyKey(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new Error('idempotencyKey has an invalid format');
  }
  return value;
}

function normalizeOptionalVersionId(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const versionId = Number(value);
  if (!Number.isInteger(versionId) || versionId <= 0) {
    throw new Error('agentVersionId must be a positive integer');
  }
  return versionId;
}

function toRunRecord(row: RunRow): RunRecord {
  return {
    id: Number(row.id),
    agentId: Number(row.agent_id),
    agentVersionId: row.agent_version_id === null ? null : Number(row.agent_version_id),
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    conversationId: row.conversation_id === null ? null : Number(row.conversation_id),
    workspaceId: Number(row.workspace_id),
    input: row.input,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}
const RUN_COLUMNS = [
  'id',
  'agent_id',
  'agent_version_id',
  'idempotency_key',
  'request_hash',
  'conversation_id',
  'workspace_id',
  'input',
  'status',
  'started_at',
  'ended_at',
].join(', ');
