import { type AsyncDatabaseAdapter } from '../db/asyncAdapter';
import { databaseTimestamp, nullableDatabaseTimestamp } from '../db/databaseTimestamp';
import { DEFAULT_WORKSPACE_ID } from '../db/workspaceDefaults';
import {
  type CreateJobInput,
  type JobRecord,
  type JobStatus,
} from './jobRepository';
import { type CreateUniqueJobInput } from './jobStore';

interface JobRow {
  id: number;
  workspace_id: number;
  type: string;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  payload_json: string;
  result_json: string;
  error: string;
  run_at: string | Date;
  started_at: string | Date | null;
  completed_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface NormalizedJobInput {
  type: string;
  workspaceId: number;
  payload: Record<string, unknown>;
  maxAttempts: number;
  runAt: string | null;
}

const JOB_COLUMNS = [
  'id', 'workspace_id', 'type', 'status', 'attempts', 'max_attempts',
  'payload_json', 'result_json', 'error', 'run_at', 'started_at',
  'completed_at', 'created_at', 'updated_at',
].join(', ');

export class AsyncJobRepository {
  constructor(private readonly database: AsyncDatabaseAdapter) {}

  async create(input: CreateJobInput): Promise<JobRecord> {
    const rows = await this.insert(normalizeJobInput(input), null, false);
    if (!rows[0]) throw new Error('created job could not be loaded');
    return toJobRecord(rows[0]);
  }

  async createUnique(input: CreateUniqueJobInput): Promise<JobRecord | null> {
    const dedupeKey = normalizeDedupeKey(input.dedupeKey);
    const rows = await this.insert(normalizeJobInput(input), dedupeKey, true);
    return rows[0] ? toJobRecord(rows[0]) : null;
  }

  async findById(id: number): Promise<JobRecord | null> {
    const rows = await this.database.query<JobRow>({
      text: `SELECT ${JOB_COLUMNS} FROM jobs WHERE id = $1 LIMIT 1;`,
      values: [id],
    });
    return rows[0] ? toJobRecord(rows[0]) : null;
  }

  async findByIdInWorkspace(id: number, workspaceId: number): Promise<JobRecord | null> {
    const rows = await this.database.query<JobRow>({
      text: `SELECT ${JOB_COLUMNS} FROM jobs WHERE id = $1 AND workspace_id = $2 LIMIT 1;`,
      values: [id, workspaceId],
    });
    return rows[0] ? toJobRecord(rows[0]) : null;
  }

  async nextRunnable(types: string[]): Promise<JobRecord | null> {
    const normalizedTypes = normalizeJobTypes(types);
    if (!normalizedTypes.length) return null;
    const rows = await this.database.query<JobRow>({
      text: `
        SELECT ${JOB_COLUMNS} FROM jobs
        WHERE status IN ('queued', 'retrying')
          AND ${this.runnableTimePredicate()}
          AND type IN (${placeholders(normalizedTypes.length)})
        ORDER BY id ASC LIMIT 1;
      `,
      values: normalizedTypes,
    });
    return rows[0] ? toJobRecord(rows[0]) : null;
  }

  async claimNext(types: string[]): Promise<JobRecord | null> {
    const normalizedTypes = normalizeJobTypes(types);
    if (!normalizedTypes.length) return null;
    const typePlaceholders = placeholders(normalizedTypes.length);
    const text = this.database.dialect === 'postgres'
      ? `
          WITH next_job AS (
            SELECT id FROM jobs
            WHERE status IN ('queued', 'retrying')
              AND run_at <= CURRENT_TIMESTAMP
              AND type IN (${typePlaceholders})
            ORDER BY id ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 1
          )
          UPDATE jobs AS job
          SET status = 'running', attempts = job.attempts + 1, error = '',
              started_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          FROM next_job
          WHERE job.id = next_job.id
          RETURNING ${qualifiedColumns('job')};
        `
      : `
          UPDATE jobs
          SET status = 'running', attempts = attempts + 1, error = '',
              started_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE id = (
            SELECT id FROM jobs
            WHERE status IN ('queued', 'retrying')
              AND datetime(run_at) <= datetime('now')
              AND type IN (${typePlaceholders})
            ORDER BY id ASC LIMIT 1
          )
          RETURNING ${JOB_COLUMNS};
        `;
    const rows = await this.database.query<JobRow>({ text, values: normalizedTypes });
    return rows[0] ? toJobRecord(rows[0]) : null;
  }

  async recoverInterrupted(types: string[]): Promise<void> {
    const normalizedTypes = normalizeJobTypes(types);
    if (!normalizedTypes.length) return;
    await this.database.execute({
      text: `
        UPDATE jobs
        SET status = CASE WHEN attempts < max_attempts THEN 'retrying' ELSE 'failed' END,
            error = 'job interrupted by process restart',
            completed_at = CASE WHEN attempts < max_attempts THEN NULL ELSE CURRENT_TIMESTAMP END,
            updated_at = CURRENT_TIMESTAMP
        WHERE status = 'running' AND type IN (${placeholders(normalizedTypes.length)});
      `,
      values: normalizedTypes,
    });
  }

  markRunning(id: number): Promise<JobRecord> {
    return this.updateAndRequire({
      text: `
        UPDATE jobs
        SET status = 'running', attempts = attempts + 1, error = '',
            started_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND status IN ('queued', 'retrying')
        RETURNING ${JOB_COLUMNS};
      `,
      values: [id],
    }, id, 'job is not runnable');
  }

  markSucceeded(id: number, result: Record<string, unknown>): Promise<JobRecord> {
    return this.updateAndRequire({
      text: `
        UPDATE jobs
        SET status = 'succeeded', result_json = $2, error = '',
            completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND status = 'running'
        RETURNING ${JOB_COLUMNS};
      `,
      values: [id, JSON.stringify(result)],
    }, id, 'job is not running');
  }

  markFailed(id: number, error: string): Promise<JobRecord> {
    return this.updateAndRequire({
      text: `
        UPDATE jobs
        SET status = CASE WHEN attempts < max_attempts THEN 'retrying' ELSE 'failed' END,
            error = $2,
            completed_at = CASE WHEN attempts < max_attempts THEN NULL ELSE CURRENT_TIMESTAMP END,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND status = 'running'
        RETURNING ${JOB_COLUMNS};
      `,
      values: [id, error],
    }, id, 'job is not running');
  }

  private insert(
    input: NormalizedJobInput,
    dedupeKey: string | null,
    ignoreConflict: boolean,
  ): Promise<JobRow[]> {
    return this.database.query<JobRow>({
      text: `
        INSERT INTO jobs (
          workspace_id, type, status, payload_json, max_attempts, run_at, dedupe_key
        ) VALUES ($1, $2, 'queued', $3, $4, COALESCE($5, CURRENT_TIMESTAMP), $6)
        ${ignoreConflict ? 'ON CONFLICT DO NOTHING' : ''}
        RETURNING ${JOB_COLUMNS};
      `,
      values: [
        input.workspaceId,
        input.type,
        JSON.stringify(input.payload),
        input.maxAttempts,
        input.runAt,
        dedupeKey,
      ],
    });
  }

  private runnableTimePredicate(): string {
    return this.database.dialect === 'postgres'
      ? 'run_at <= CURRENT_TIMESTAMP'
      : "datetime(run_at) <= datetime('now')";
  }

  private async updateAndRequire(
    statement: { text: string; values: [number, ...Array<string>] },
    id: number,
    stateError: string,
  ): Promise<JobRecord> {
    const rows = await this.database.query<JobRow>(statement);
    if (rows[0]) return toJobRecord(rows[0]);
    if (!await this.findById(id)) throw new Error(`job ${id} not found`);
    throw new Error(`${stateError}: ${id}`);
  }
}

function normalizeJobInput(input: CreateJobInput): NormalizedJobInput {
  if (typeof input.type !== 'string' || !input.type.trim()) {
    throw new Error('job type is required');
  }
  const maxAttempts = input.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) {
    throw new Error('maxAttempts must be a positive integer');
  }
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  if (!Number.isSafeInteger(workspaceId) || workspaceId <= 0) {
    throw new Error('workspaceId must be a positive integer');
  }
  return {
    type: input.type.trim(),
    workspaceId,
    payload: input.payload ?? {},
    maxAttempts,
    runAt: input.runAt ?? null,
  };
}

function normalizeDedupeKey(value: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > 200) throw new Error('job dedupeKey is invalid');
  return normalized;
}

function normalizeJobTypes(types: string[]): string[] {
  return [...new Set(types.map((type) => type.trim()).filter(Boolean))];
}

function placeholders(count: number): string {
  return Array.from({ length: count }, (_, index) => `$${index + 1}`).join(', ');
}

function qualifiedColumns(alias: string): string {
  return JOB_COLUMNS.split(', ').map((column) => `${alias}.${column}`).join(', ');
}

function toJobRecord(row: JobRow): JobRecord {
  return {
    id: Number(row.id),
    workspaceId: Number(row.workspace_id),
    type: row.type,
    status: row.status,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    result: JSON.parse(row.result_json) as Record<string, unknown>,
    error: row.error,
    runAt: databaseTimestamp(row.run_at),
    startedAt: nullableDatabaseTimestamp(row.started_at),
    completedAt: nullableDatabaseTimestamp(row.completed_at),
    createdAt: databaseTimestamp(row.created_at),
    updatedAt: databaseTimestamp(row.updated_at),
  };
}
