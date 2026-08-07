import { type AsyncDatabaseAdapter } from '../db/asyncAdapter';
import { databaseTimestamp, nullableDatabaseTimestamp } from '../db/databaseTimestamp';
import { type CapabilityRunSnapshot } from './capabilitySettingsRepository';
import { type CreateRunInput, type RunRecord } from './runRepository';

interface RunRow {
  id: number;
  agent_id: number;
  agent_version_id: number | null;
  idempotency_key: string | null;
  request_hash: string;
  conversation_id: number | null;
  capability_snapshot_json: string;
  workspace_id: number;
  input: string;
  status: string;
  started_at: string | Date;
  ended_at: string | Date | null;
}

const RUN_COLUMNS = [
  'id', 'agent_id', 'agent_version_id', 'idempotency_key', 'request_hash',
  'conversation_id', 'capability_snapshot_json', 'workspace_id', 'input',
  'status', 'started_at', 'ended_at',
].join(', ');

function normalizeRunInput(input: CreateRunInput): CreateRunInput {
  const agentId = Number(input.agentId);
  if (!Number.isInteger(agentId) || agentId <= 0) {
    throw new Error('agentId must be a positive integer');
  }
  if (typeof input.input !== 'string' || !input.input.trim()) {
    throw new Error('run input is required');
  }
  const agentVersionId = input.agentVersionId === undefined || input.agentVersionId === null
    ? null
    : Number(input.agentVersionId);
  if (agentVersionId !== null && (!Number.isInteger(agentVersionId) || agentVersionId <= 0)) {
    throw new Error('agentVersionId must be a positive integer');
  }
  const idempotencyKey = input.idempotencyKey ?? null;
  if (
    idempotencyKey !== null
    && (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey))
  ) {
    throw new Error('idempotencyKey has an invalid format');
  }
  return {
    agentId,
    input: input.input.trim(),
    agentVersionId,
    idempotencyKey,
    requestHash: typeof input.requestHash === 'string' ? input.requestHash : '',
    capabilitySnapshot: input.capabilitySnapshot,
  };
}

function toRunRecord(row: RunRow): RunRecord {
  return {
    id: Number(row.id),
    agentId: Number(row.agent_id),
    agentVersionId: row.agent_version_id === null ? null : Number(row.agent_version_id),
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    conversationId: row.conversation_id === null ? null : Number(row.conversation_id),
    capabilitySnapshot: JSON.parse(row.capability_snapshot_json) as CapabilityRunSnapshot,
    workspaceId: Number(row.workspace_id),
    input: row.input,
    status: row.status,
    startedAt: databaseTimestamp(row.started_at),
    endedAt: nullableDatabaseTimestamp(row.ended_at),
  };
}

export class AsyncRunRepository {
  constructor(private readonly database: AsyncDatabaseAdapter) {}

  async create(input: CreateRunInput): Promise<RunRecord> {
    const normalized = normalizeRunInput(input);
    const rows = await this.database.query<RunRow>({
      text: `
        INSERT INTO runs (
          agent_id, agent_version_id, workspace_id, input, status,
          idempotency_key, request_hash, capability_snapshot_json
        )
        SELECT $1, $2, a.workspace_id, $3, 'pending', $4, $5, $6
        FROM agents a WHERE a.id = $1
        RETURNING ${RUN_COLUMNS};
      `,
      values: [
        normalized.agentId,
        normalized.agentVersionId ?? null,
        normalized.input,
        normalized.idempotencyKey ?? null,
        normalized.requestHash ?? '',
        JSON.stringify(normalized.capabilitySnapshot ?? {}),
      ],
    });
    if (!rows[0]) throw new Error('created run could not be loaded');
    return toRunRecord(rows[0]);
  }

  async findById(id: number): Promise<RunRecord | null> {
    const rows = await this.database.query<RunRow>({
      text: `SELECT ${RUN_COLUMNS} FROM runs WHERE id = $1 LIMIT 1;`,
      values: [id],
    });
    return rows[0] ? toRunRecord(rows[0]) : null;
  }

  async findByIdInWorkspace(id: number, workspaceId: number): Promise<RunRecord | null> {
    const rows = await this.database.query<RunRow>({
      text: `SELECT ${RUN_COLUMNS} FROM runs WHERE id = $1 AND workspace_id = $2 LIMIT 1;`,
      values: [id, workspaceId],
    });
    return rows[0] ? toRunRecord(rows[0]) : null;
  }

  async findByIdempotencyKey(
    workspaceId: number,
    idempotencyKey: string,
  ): Promise<RunRecord | null> {
    const rows = await this.database.query<RunRow>({
      text: `
        SELECT ${RUN_COLUMNS} FROM runs
        WHERE workspace_id = $1 AND idempotency_key = $2 LIMIT 1;
      `,
      values: [workspaceId, idempotencyKey],
    });
    return rows[0] ? toRunRecord(rows[0]) : null;
  }

  async attachConversation(id: number, conversationId: number): Promise<RunRecord> {
    const rows = await this.database.query<RunRow>({
      text: `UPDATE runs SET conversation_id = $1 WHERE id = $2 RETURNING ${RUN_COLUMNS};`,
      values: [conversationId, id],
    });
    if (!rows[0]) throw new Error(`run ${id} not found`);
    return toRunRecord(rows[0]);
  }

  async updateStatus(
    id: number,
    status: string,
    endedAt: string | null = null,
  ): Promise<RunRecord> {
    const rows = await this.database.query<RunRow>({
      text: `
        UPDATE runs SET status = $1, ended_at = $2
        WHERE id = $3 RETURNING ${RUN_COLUMNS};
      `,
      values: [status, endedAt, id],
    });
    if (!rows[0]) throw new Error(`run ${id} not found`);
    return toRunRecord(rows[0]);
  }
}
