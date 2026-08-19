import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { PostgresDatabase } from '../db/postgres';
import { runPostgresMigrations } from '../db/postgresMigrations';
import { DEFAULT_WORKSPACE_ID } from '../db/workspaceDefaults';
import { AsyncJobRepository } from '../services/asyncJobRepository';
import { DurableJobDispatcher } from '../services/durableJobDispatcher';

const LOAD_JOB_COUNT = 64;
const POLL_INTERVAL_MS = 25;
const HEARTBEAT_INTERVAL_MS = 250;

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');

  const database = new PostgresDatabase({ connectionString, max: 8 });
  const marker = randomUUID();
  const loadType = `smoke.worker.load.${marker}`;
  const failoverType = `smoke.worker.failover.${marker}`;
  const createdIds: number[] = [];
  const dispatchErrors: string[] = [];
  const callsBySequence = new Map<number, number>();
  const processedBy = new Map<string, number>();
  const readyWorkers = new Set<string>();
  let releaseWorkers: () => void = () => undefined;
  const workersReady = new Promise<void>((resolve) => { releaseWorkers = resolve; });
  let failoverCalls = 0;
  let firstDispatcher: DurableJobDispatcher | undefined;
  let survivingDispatcher: DurableJobDispatcher | undefined;

  const recordDispatchError = (error: unknown): void => {
    dispatchErrors.push(error instanceof Error ? error.message : String(error));
  };
  const loadHandler = (worker: string) => async (payload: Record<string, unknown>) => {
    const sequence = requiredSequence(payload.sequence);
    callsBySequence.set(sequence, (callsBySequence.get(sequence) ?? 0) + 1);
    processedBy.set(worker, (processedBy.get(worker) ?? 0) + 1);
    readyWorkers.add(worker);
    if (readyWorkers.size === 2) releaseWorkers();
    if (readyWorkers.size < 2) await withTimeout(workersReady, 3_000, 'second Worker did not claim load');
    await delay(5);
    return { marker, sequence, worker };
  };

  try {
    await runPostgresMigrations(database);
    const firstJobs = new AsyncJobRepository(database, {
      leaseDurationMs: 1_000,
      leaseOwner: `smoke-first-${marker}`,
    });
    const survivingJobs = new AsyncJobRepository(database, {
      leaseDurationMs: 1_000,
      leaseOwner: `smoke-surviving-${marker}`,
    });
    firstDispatcher = new DurableJobDispatcher(firstJobs, {
      [loadType]: loadHandler('first'),
    }, recordDispatchError, HEARTBEAT_INTERVAL_MS);
    survivingDispatcher = new DurableJobDispatcher(survivingJobs, {
      [loadType]: loadHandler('surviving'),
      [failoverType]: async () => {
        failoverCalls += 1;
        return { marker, worker: 'surviving' };
      },
    }, recordDispatchError, HEARTBEAT_INTERVAL_MS);

    const loadJobs = await Promise.all(Array.from({ length: LOAD_JOB_COUNT }, (_, sequence) => (
      firstJobs.create({
        type: loadType,
        workspaceId: DEFAULT_WORKSPACE_ID,
        payload: { marker, sequence },
        maxAttempts: 2,
      })
    )));
    createdIds.push(...loadJobs.map((job) => job.id));

    const loadStartedAt = Date.now();
    firstDispatcher.start(POLL_INTERVAL_MS, false);
    survivingDispatcher.start(POLL_INTERVAL_MS, false);
    await waitFor(async () => {
      const jobs = await Promise.all(loadJobs.map((job) => survivingJobs.findById(job.id)));
      return jobs.every((job) => job?.status === 'succeeded');
    }, 15_000, 'Worker load did not drain');
    const loadElapsedMs = Date.now() - loadStartedAt;

    assert.equal(dispatchErrors.length, 0, `Worker load dispatch errors: ${dispatchErrors.join('; ')}`);
    assert.equal(callsBySequence.size, LOAD_JOB_COUNT);
    assert.ok([...callsBySequence.values()].every((count) => count === 1));
    assert.ok((processedBy.get('first') ?? 0) > 0);
    assert.ok((processedBy.get('surviving') ?? 0) > 0);
    const completedLoadJobs = await Promise.all(
      loadJobs.map((job) => survivingJobs.findById(job.id)),
    );
    assert.ok(completedLoadJobs.every((job) => job?.attempts === 1));

    await firstDispatcher.stop();
    firstDispatcher = undefined;

    const crashedJobs = new AsyncJobRepository(database, {
      leaseDurationMs: 1_000,
      leaseOwner: `smoke-crashed-${marker}`,
    });
    const failoverJob = await crashedJobs.create({
      type: failoverType,
      workspaceId: DEFAULT_WORKSPACE_ID,
      payload: { marker },
      maxAttempts: 2,
    });
    createdIds.push(failoverJob.id);
    const abandonedLease = await crashedJobs.claimNext([failoverType]);
    assert.equal(abandonedLease?.id, failoverJob.id);

    await delay(400);
    const activeLease = await survivingJobs.findById(failoverJob.id);
    assert.equal(activeLease?.status, 'running');
    assert.equal(activeLease?.attempts, 1);
    assert.equal(failoverCalls, 0);

    const failoverStartedAt = Date.now();
    await waitFor(async () => (
      (await survivingJobs.findById(failoverJob.id))?.status === 'succeeded'
    ), 5_000, 'surviving Worker did not recover the expired lease');
    const failoverElapsedMs = Date.now() - failoverStartedAt;
    const recovered = await survivingJobs.findById(failoverJob.id);
    assert.equal(recovered?.attempts, 2);
    assert.deepEqual(recovered?.result, { marker, worker: 'surviving' });
    assert.equal(failoverCalls, 1);
    await assert.rejects(
      crashedJobs.markSucceeded(failoverJob.id, { marker, worker: 'crashed' }),
      /lease is not owned/,
    );
    assert.equal(dispatchErrors.length, 0, `Worker failover dispatch errors: ${dispatchErrors.join('; ')}`);

    process.stdout.write(`${JSON.stringify({
      status: 'passed',
      loadJobs: LOAD_JOB_COUNT,
      loadElapsedMs,
      processedBy: Object.fromEntries(processedBy),
      failoverAttempts: recovered?.attempts,
      failoverElapsedMs,
    })}\n`);
  } finally {
    await firstDispatcher?.stop().catch(() => undefined);
    await survivingDispatcher?.stop().catch(() => undefined);
    if (createdIds.length) {
      await database.execute({
        text: `DELETE FROM jobs WHERE id IN (${createdIds.map((_, index) => `$${index + 1}`).join(', ')});`,
        values: createdIds,
      }).catch(() => undefined);
    }
    await database.close();
  }
}

function requiredSequence(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error('Worker load payload sequence is invalid');
  }
  return Number(value);
}

async function withTimeout(
  operation: Promise<void>,
  timeoutMs: number,
  message: string,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(message);
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'PostgreSQL Worker failover smoke failed'}\n`);
  process.exitCode = 1;
});
