import { randomUUID } from 'node:crypto';

import { type DatabaseAdapter } from '../db/adapter';
import { sqlValue } from '../db/sql';
import { DEFAULT_WORKSPACE_ID } from '../db/workspaceDefaults';
import {
  DEFAULT_JOB_LEASE_DURATION_MS,
  type CreateUniqueJobInput,
  type JobRepositoryOptions,
} from './jobStore';

export type JobStatus = 'queued' | 'running' | 'retrying' | 'succeeded' | 'failed';

export interface JobRecord {
  id: number;
  workspaceId: number;
  type: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  payload: Record<string, unknown>;
  result: Record<string, unknown>;
  error: string;
  runAt: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateJobInput {
  type: string;
  workspaceId?: number;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
  runAt?: string;
}

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
  run_at: string;
  started_at: string | null;
  completed_at: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export class JobRepository {
  private readonly leaseDurationSeconds: string;
  private readonly leaseOwner: string;

  constructor(
    private readonly db: DatabaseAdapter,
    options: JobRepositoryOptions = {},
  ) {
    this.leaseOwner = normalizeLeaseOwner(options.leaseOwner ?? randomUUID());
    this.leaseDurationSeconds = (normalizeLeaseDuration(
      options.leaseDurationMs ?? DEFAULT_JOB_LEASE_DURATION_MS,
    ) / 1_000).toFixed(3);
  }

  create(input: CreateJobInput): JobRecord {
    const normalized = normalizeJobInput(input);
    this.db.run(`
      INSERT INTO jobs (
        workspace_id,
        type,
        status,
        payload_json,
        max_attempts,
        run_at
      )
      VALUES (
        ${sqlValue(normalized.workspaceId)},
        ${sqlValue(normalized.type)},
        'queued',
        ${sqlValue(JSON.stringify(normalized.payload))},
        ${sqlValue(normalized.maxAttempts)},
        ${sqlValue(normalized.runAt)}
      );
    `);

    const rows = this.db.query<JobRow>(`
      SELECT ${JOB_COLUMNS}
      FROM jobs
      ORDER BY id DESC
      LIMIT 1;
    `);
    if (!rows[0]) {
      throw new Error('created job could not be loaded');
    }
    return toJobRecord(rows[0]);
  }

  createUnique(input: CreateUniqueJobInput): JobRecord | null {
    const normalized = normalizeJobInput(input);
    const dedupeKey = normalizeDedupeKey(input.dedupeKey);
    const rows = this.db.query<JobRow>(`
      INSERT INTO jobs (
        workspace_id, type, status, payload_json, max_attempts, run_at, dedupe_key
      )
      VALUES (
        ${sqlValue(normalized.workspaceId)},
        ${sqlValue(normalized.type)},
        'queued',
        ${sqlValue(JSON.stringify(normalized.payload))},
        ${sqlValue(normalized.maxAttempts)},
        ${sqlValue(normalized.runAt)},
        ${sqlValue(dedupeKey)}
      )
      ON CONFLICT DO NOTHING
      RETURNING ${JOB_COLUMNS};
    `);
    return rows[0] ? toJobRecord(rows[0]) : null;
  }

  findById(id: number): JobRecord | null {
    const rows = this.db.query<JobRow>(`
      SELECT ${JOB_COLUMNS}
      FROM jobs
      WHERE id = ${sqlValue(id)}
      LIMIT 1;
    `);
    return rows[0] ? toJobRecord(rows[0]) : null;
  }

  findByIdInWorkspace(id: number, workspaceId: number): JobRecord | null {
    const job = this.findById(id);
    return job?.workspaceId === workspaceId ? job : null;
  }

  hasActive(type: string, workspaceId: number): boolean {
    const row = this.db.query<{ count: number }>(`
      SELECT COUNT(*) AS count
      FROM jobs
      WHERE type = ${sqlValue(type)}
        AND workspace_id = ${sqlValue(workspaceId)}
        AND status IN ('queued', 'running', 'retrying');
    `)[0];
    return Number(row?.count ?? 0) > 0;
  }

  hasActiveForPayload(type: string, key: string, value: string): boolean {
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key)) throw new Error('job payload key is invalid');
    const row = this.db.query<{ count: number }>(`
      SELECT COUNT(*) AS count FROM jobs
      WHERE type = ${sqlValue(type)}
        AND json_extract(payload_json, ${sqlValue(`$.${key}`)}) = ${sqlValue(value)}
        AND status IN ('queued', 'running', 'retrying');
    `)[0];
    return Number(row?.count ?? 0) > 0;
  }

  nextRunnable(types: string[]): JobRecord | null {
    if (!types.length) return null;
    const rows = this.db.query<JobRow>(`
      SELECT ${JOB_COLUMNS}
      FROM jobs
      WHERE status IN ('queued', 'retrying')
        AND datetime(run_at) <= datetime('now')
        AND type IN (${types.map(sqlValue).join(', ')})
      ORDER BY id ASC
      LIMIT 1;
    `);
    return rows[0] ? toJobRecord(rows[0]) : null;
  }

  claimNext(types: string[]): JobRecord | null {
    if (!types.length) return null;
    const rows = this.db.query<JobRow>(`
      UPDATE jobs
      SET
        status = 'running',
        attempts = attempts + 1,
        error = '',
        started_at = CURRENT_TIMESTAMP,
        lease_owner = ${sqlValue(this.leaseOwner)},
        lease_expires_at = strftime(
          '%Y-%m-%dT%H:%M:%fZ', 'now', ${sqlValue(`+${this.leaseDurationSeconds} seconds`)}
        ),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = (
        SELECT id FROM jobs
        WHERE status IN ('queued', 'retrying')
          AND datetime(run_at) <= datetime('now')
          AND type IN (${types.map(sqlValue).join(', ')})
        ORDER BY id ASC
        LIMIT 1
      )
      RETURNING ${JOB_COLUMNS};
    `);
    return rows[0] ? toJobRecord(rows[0]) : null;
  }

  recoverInterrupted(types: string[]): void {
    if (!types.length) return;
    this.db.run(`
      UPDATE jobs
      SET
        status = CASE
          WHEN attempts < max_attempts THEN 'retrying'
          ELSE 'failed'
        END,
        error = 'job interrupted by process restart',
        completed_at = CASE
          WHEN attempts < max_attempts THEN NULL
          ELSE CURRENT_TIMESTAMP
        END,
        lease_owner = NULL,
        lease_expires_at = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE status = 'running'
        AND (lease_owner IS NULL OR julianday(lease_expires_at) <= julianday('now'))
        AND type IN (${types.map(sqlValue).join(', ')});
    `);
  }

  renewLease(id: number): boolean {
    const rows = this.db.query<{ id: number }>(`
      UPDATE jobs
      SET lease_expires_at = strftime(
            '%Y-%m-%dT%H:%M:%fZ', 'now', ${sqlValue(`+${this.leaseDurationSeconds} seconds`)}
          ),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ${sqlValue(id)}
        AND status = 'running'
        AND lease_owner = ${sqlValue(this.leaseOwner)}
      RETURNING id;
    `);
    return rows.length === 1;
  }

  markRunning(id: number): JobRecord {
    this.db.run(`
      UPDATE jobs
      SET
        status = 'running',
        attempts = attempts + 1,
        error = '',
        started_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${sqlValue(id)};
    `);
    return this.requireJob(id);
  }

  markSucceeded(id: number, result: Record<string, unknown>): JobRecord {
    const rows = this.db.query<JobRow>(`
      UPDATE jobs
      SET
        status = 'succeeded',
        result_json = ${sqlValue(JSON.stringify(result))},
        error = '',
        completed_at = CURRENT_TIMESTAMP,
        lease_owner = NULL,
        lease_expires_at = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${sqlValue(id)}
        AND status = 'running'
        AND (lease_owner IS NULL OR lease_owner = ${sqlValue(this.leaseOwner)})
      RETURNING ${JOB_COLUMNS};
    `);
    if (rows[0]) return toJobRecord(rows[0]);
    this.requireJob(id);
    throw new Error(`job is not running or lease is not owned: ${id}`);
  }

  markFailed(id: number, error: string): JobRecord {
    const job = this.requireJob(id);
    const status: JobStatus = job.attempts < job.maxAttempts ? 'retrying' : 'failed';
    const completedAt = status === 'failed' ? 'CURRENT_TIMESTAMP' : 'NULL';

    const rows = this.db.query<JobRow>(`
      UPDATE jobs
      SET
        status = ${sqlValue(status)},
        error = ${sqlValue(error)},
        completed_at = ${completedAt},
        lease_owner = NULL,
        lease_expires_at = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${sqlValue(id)}
        AND status = 'running'
        AND (lease_owner IS NULL OR lease_owner = ${sqlValue(this.leaseOwner)})
      RETURNING ${JOB_COLUMNS};
    `);
    if (rows[0]) return toJobRecord(rows[0]);
    this.requireJob(id);
    throw new Error(`job is not running or lease is not owned: ${id}`);
  }

  private requireJob(id: number): JobRecord {
    const job = this.findById(id);
    if (!job) {
      throw new Error(`job ${id} not found`);
    }
    return job;
  }
}

const JOB_COLUMNS = [
  'id',
  'workspace_id',
  'type',
  'status',
  'attempts',
  'max_attempts',
  'payload_json',
  'result_json',
  'error',
  'run_at',
  'started_at',
  'completed_at',
  'lease_owner',
  'lease_expires_at',
  'created_at',
  'updated_at',
].join(', ');

function normalizeJobInput(input: CreateJobInput): Required<CreateJobInput> {
  if (typeof input.type !== 'string' || !input.type.trim()) {
    throw new Error('job type is required');
  }

  const maxAttempts = input.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) {
    throw new Error('maxAttempts must be a positive integer');
  }

  return {
    type: input.type.trim(),
    workspaceId: input.workspaceId ?? DEFAULT_WORKSPACE_ID,
    payload: input.payload ?? {},
    maxAttempts,
    runAt: input.runAt ?? new Date().toISOString(),
  };
}

function normalizeDedupeKey(value: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > 200) throw new Error('job dedupeKey is invalid');
  return normalized;
}

function normalizeLeaseDuration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 60 * 60_000) {
    throw new Error('job lease duration is invalid');
  }
  return value;
}

function normalizeLeaseOwner(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) throw new Error('job lease owner is invalid');
  return normalized;
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
    runAt: row.run_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
