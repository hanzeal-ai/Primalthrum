import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { PostgresDatabase } from '../db/postgres';
import { runPostgresMigrations } from '../db/postgresMigrations';
import { DEFAULT_WORKSPACE_ID } from '../db/workspaceDefaults';
import { AsyncJobRepository } from '../services/asyncJobRepository';
import { DurableJobDispatcher } from '../services/durableJobDispatcher';

const BEFORE_SHUTDOWN_JOBS = 48;
const DURING_SHUTDOWN_JOBS = 16;
const POLL_INTERVAL_MS = 25;

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');

  const database = new PostgresDatabase({ connectionString, max: 8 });
  const marker = randomUUID();
  const jobType = `smoke.worker.rollout.${marker}`;
  const createdIds: number[] = [];
  const dispatchErrors: string[] = [];
  const callsBySequence = new Map<number, number>();
  const processedBy = new Map<string, number>();
  const oldJobActive = deferred<void>();
  const releaseOldJob = deferred<void>();
  let oldDispatcher: DurableJobDispatcher | undefined;
  let newDispatcher: DurableJobDispatcher | undefined;

  const databaseOptions = { leaseDurationMs: 1_000 };
  const oldJobs = new AsyncJobRepository(database, {
    ...databaseOptions,
    leaseOwner: `smoke-old-${marker}`,
  });
  const newJobs = new AsyncJobRepository(database, {
    ...databaseOptions,
    leaseOwner: `smoke-new-${marker}`,
  });
  const recordError = (error: unknown): void => {
    dispatchErrors.push(error instanceof Error ? error.message : String(error));
  };
  const handler = (worker: string) => async (payload: Record<string, unknown>) => {
    const sequence = Number(payload.sequence);
    if (!Number.isSafeInteger(sequence)) throw new Error('rolling Job sequence is invalid');
    callsBySequence.set(sequence, (callsBySequence.get(sequence) ?? 0) + 1);
    processedBy.set(worker, (processedBy.get(worker) ?? 0) + 1);
    if (worker === 'old' && payload.hold === true) {
      oldJobActive.resolve();
      await releaseOldJob.promise;
    }
    await delay(5);
    return { marker, sequence, worker };
  };

  try {
    await runPostgresMigrations(database);
    oldDispatcher = new DurableJobDispatcher(
      oldJobs,
      { [jobType]: handler('old') },
      recordError,
      250,
    );
    newDispatcher = new DurableJobDispatcher(
      newJobs,
      { [jobType]: handler('new') },
      recordError,
      250,
    );

    const heldJob = await oldJobs.create({
      type: jobType,
      workspaceId: DEFAULT_WORKSPACE_ID,
      payload: { marker, sequence: 0, hold: true },
      maxAttempts: 2,
    });
    createdIds.push(heldJob.id);
    oldDispatcher.start(POLL_INTERVAL_MS, false);
    await withTimeout(oldJobActive.promise, 3_000, 'old Worker did not start its active Job');

    newDispatcher.start(POLL_INTERVAL_MS, false);
    const beforeShutdown = await createJobs(
      oldJobs,
      jobType,
      marker,
      1,
      BEFORE_SHUTDOWN_JOBS,
    );
    createdIds.push(...beforeShutdown.map((job) => job.id));
    await waitFor(
      () => (processedBy.get('new') ?? 0) >= 8,
      5_000,
      'new Worker did not become ready before old Worker shutdown',
    );

    let oldStopped = false;
    const stopOld = oldDispatcher.stop().then(() => { oldStopped = true; });
    await delay(50);
    assert.equal(oldStopped, false);
    const processedBeforeOldRelease = processedBy.get('new') ?? 0;

    const duringShutdown = await createJobs(
      oldJobs,
      jobType,
      marker,
      BEFORE_SHUTDOWN_JOBS + 1,
      DURING_SHUTDOWN_JOBS,
    );
    createdIds.push(...duringShutdown.map((job) => job.id));
    releaseOldJob.resolve();
    await stopOld;
    oldDispatcher = undefined;

    const allJobs = [heldJob, ...beforeShutdown, ...duringShutdown];
    await waitForAsync(async () => {
      const jobs = await Promise.all(allJobs.map((job) => newJobs.findById(job.id)));
      return jobs.every((job) => job?.status === 'succeeded');
    }, 10_000, 'new Worker did not drain rolling handoff Jobs');

    const completed = await Promise.all(allJobs.map((job) => newJobs.findById(job.id)));
    assert.equal(dispatchErrors.length, 0, dispatchErrors.join('; '));
    assert.equal(processedBy.get('old'), 1);
    assert.equal(processedBy.get('new'), BEFORE_SHUTDOWN_JOBS + DURING_SHUTDOWN_JOBS);
    assert.ok(processedBeforeOldRelease >= 8);
    assert.equal(callsBySequence.size, allJobs.length);
    assert.ok([...callsBySequence.values()].every((count) => count === 1));
    assert.ok(completed.every((job) => job?.attempts === 1));
    assert.equal(completed.find((job) => job?.id === heldJob.id)?.result.worker, 'old');
    assert.ok(completed.filter((job) => job?.id !== heldJob.id).every((job) => (
      job?.result.worker === 'new'
    )));

    process.stdout.write(`${JSON.stringify({
      status: 'passed',
      totalJobs: allJobs.length,
      processedBy: Object.fromEntries(processedBy),
      processedBeforeOldRelease,
      duringShutdownJobs: DURING_SHUTDOWN_JOBS,
    })}\n`);
  } finally {
    releaseOldJob.resolve();
    await oldDispatcher?.stop().catch(() => undefined);
    await newDispatcher?.stop().catch(() => undefined);
    if (createdIds.length) {
      await database.execute({
        text: `DELETE FROM jobs WHERE id IN (${createdIds.map((_, index) => `$${index + 1}`).join(', ')});`,
        values: createdIds,
      }).catch(() => undefined);
    }
    await database.close();
  }
}

async function createJobs(
  jobs: AsyncJobRepository,
  type: string,
  marker: string,
  startSequence: number,
  count: number,
) {
  return Promise.all(Array.from({ length: count }, (_, index) => jobs.create({
    type,
    workspaceId: DEFAULT_WORKSPACE_ID,
    payload: { marker, sequence: startSequence + index },
    maxAttempts: 2,
  })));
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
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
  predicate: () => boolean,
  timeoutMs: number,
  message: string,
): Promise<void> {
  await waitForAsync(async () => predicate(), timeoutMs, message);
}

async function waitForAsync(
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
  process.stderr.write(`${error instanceof Error ? error.message : 'Worker rolling smoke failed'}\n`);
  process.exitCode = 1;
});
