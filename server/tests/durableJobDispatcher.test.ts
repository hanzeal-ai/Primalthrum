import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createSqliteDatabase } from '../src/db/databaseFactory';
import { DurableJobDispatcher } from '../src/services/durableJobDispatcher';
import { JobRepository } from '../src/services/jobRepository';

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition was not met before timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('dispatcher polling claims jobs created by another process', async () => {
  const root = mkdtempSync(join(tmpdir(), 'primalthrum-job-polling-'));
  const jobs = new JobRepository(createSqliteDatabase(join(root, 'platform.sqlite')));
  const dispatcher = new DurableJobDispatcher(jobs, {
    'demo.poll': (payload) => ({ received: payload.value }),
  });

  try {
    dispatcher.start(25);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const job = jobs.create({ type: 'demo.poll', payload: { value: 'external' } });

    await waitFor(() => jobs.findById(job.id)?.status === 'succeeded');
    assert.deepEqual(jobs.findById(job.id)?.result, { received: 'external' });
  } finally {
    await dispatcher.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('dispatcher stop waits for the active job and does not claim another', async () => {
  const root = mkdtempSync(join(tmpdir(), 'primalthrum-job-stop-'));
  const jobs = new JobRepository(createSqliteDatabase(join(root, 'platform.sqlite')));
  let releaseActiveJob: (() => void) | undefined;
  let calls = 0;
  const activeJob = new Promise<void>((resolve) => { releaseActiveJob = resolve; });
  const dispatcher = new DurableJobDispatcher(jobs, {
    'demo.stop': async () => {
      calls += 1;
      await activeJob;
      return { completed: true };
    },
  });
  const first = jobs.create({ type: 'demo.stop' });
  const second = jobs.create({ type: 'demo.stop' });

  try {
    dispatcher.start(25);
    await waitFor(() => calls === 1);
    let stopped = false;
    const stopping = dispatcher.stop().then(() => { stopped = true; });

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(stopped, false);
    releaseActiveJob?.();
    await stopping;

    assert.equal(jobs.findById(first.id)?.status, 'succeeded');
    assert.equal(jobs.findById(second.id)?.status, 'queued');
    assert.equal(calls, 1);
  } finally {
    releaseActiveJob?.();
    await dispatcher.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('starting another dispatcher does not recover an active leased job', async () => {
  const root = mkdtempSync(join(tmpdir(), 'primalthrum-job-lease-'));
  const database = createSqliteDatabase(join(root, 'platform.sqlite'));
  const firstJobs = new JobRepository(database, {
    leaseDurationMs: 1_000,
    leaseOwner: 'worker-first',
  });
  const secondJobs = new JobRepository(database, {
    leaseDurationMs: 1_000,
    leaseOwner: 'worker-second',
  });
  let releaseActiveJob: (() => void) | undefined;
  const activeJob = new Promise<void>((resolve) => { releaseActiveJob = resolve; });
  let firstCalls = 0;
  let secondCalls = 0;
  const first = new DurableJobDispatcher(firstJobs, {
    'demo.lease': async () => {
      firstCalls += 1;
      await activeJob;
      return { worker: 'first' };
    },
  }, () => undefined, 250);
  const second = new DurableJobDispatcher(secondJobs, {
    'demo.lease': () => {
      secondCalls += 1;
      return { worker: 'second' };
    },
  }, () => undefined, 250);
  const job = firstJobs.create({ type: 'demo.lease', maxAttempts: 2 });

  try {
    first.start(25);
    await waitFor(() => firstCalls === 1);
    await new Promise((resolve) => setTimeout(resolve, 1_250));
    second.start(25);
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(firstJobs.findById(job.id)?.status, 'running');
    assert.equal(secondCalls, 0);
    releaseActiveJob?.();
    await waitFor(() => firstJobs.findById(job.id)?.status === 'succeeded');
    assert.deepEqual(firstJobs.findById(job.id)?.result, { worker: 'first' });
  } finally {
    releaseActiveJob?.();
    await Promise.all([first.stop(), second.stop()]);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a surviving dispatcher recovers an expired lease without restarting', async () => {
  const root = mkdtempSync(join(tmpdir(), 'primalthrum-job-takeover-'));
  const database = createSqliteDatabase(join(root, 'platform.sqlite'));
  const crashedWorker = new JobRepository(database, {
    leaseDurationMs: 1_000,
    leaseOwner: 'worker-crashed',
  });
  const survivingJobs = new JobRepository(database, {
    leaseDurationMs: 1_000,
    leaseOwner: 'worker-surviving',
  });
  let calls = 0;
  const survivingWorker = new DurableJobDispatcher(survivingJobs, {
    'demo.takeover': () => {
      calls += 1;
      return { worker: 'surviving' };
    },
  }, () => undefined, 250);
  const job = crashedWorker.create({ type: 'demo.takeover', maxAttempts: 2 });
  crashedWorker.claimNext(['demo.takeover']);

  try {
    survivingWorker.start(25);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(calls, 0);
    assert.equal(survivingJobs.findById(job.id)?.status, 'running');

    await waitFor(() => survivingJobs.findById(job.id)?.status === 'succeeded', 2_000);
    assert.equal(calls, 1);
    assert.equal(survivingJobs.findById(job.id)?.attempts, 2);
    assert.deepEqual(survivingJobs.findById(job.id)?.result, { worker: 'surviving' });
  } finally {
    await survivingWorker.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
