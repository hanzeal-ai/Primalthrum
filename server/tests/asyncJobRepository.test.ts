import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAsyncSqliteDatabase } from '../src/db/asyncDatabaseFactory';
import { type AsyncSqliteDatabase } from '../src/db/asyncSqlite';
import { AsyncJobRepository } from '../src/services/asyncJobRepository';

function createDatabase(): { database: AsyncSqliteDatabase; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'primalthrum-async-job-'));
  return {
    database: createAsyncSqliteDatabase(join(root, 'database.sqlite')),
    root,
  };
}

test('async jobs enforce active deduplication and atomic claims', async () => {
  const { database, root } = createDatabase();
  const firstWorker = new AsyncJobRepository(database);
  const secondWorker = new AsyncJobRepository(database);
  try {
    const created = await Promise.all([
      firstWorker.createUnique({
        type: 'document.index',
        workspaceId: 1,
        payload: { documentId: 7 },
        dedupeKey: 'document:7',
      }),
      secondWorker.createUnique({
        type: 'document.index',
        workspaceId: 1,
        payload: { documentId: 7 },
        dedupeKey: 'document:7',
      }),
    ]);
    assert.equal(created.filter(Boolean).length, 1);

    const claims = await Promise.all([
      firstWorker.claimNext(['document.index']),
      secondWorker.claimNext(['document.index']),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    const running = claims.find(Boolean);
    assert.equal(running?.status, 'running');
    assert.equal(running?.attempts, 1);
    assert.equal(await firstWorker.claimNext(['document.index']), null);

    const retrying = await firstWorker.markFailed(running?.id ?? 0, 'temporary failure');
    assert.equal(retrying.status, 'retrying');
    assert.equal(await firstWorker.createUnique({
      type: 'document.index',
      workspaceId: 1,
      payload: { documentId: 7 },
      dedupeKey: 'document:7',
    }), null);

    const finalAttempt = await secondWorker.claimNext(['document.index']);
    assert.equal(finalAttempt?.attempts, 2);
    const succeeded = await secondWorker.markSucceeded(finalAttempt?.id ?? 0, { indexed: true });
    assert.equal(succeeded.status, 'succeeded');
    assert.deepEqual(succeeded.result, { indexed: true });

    const replacement = await firstWorker.createUnique({
      type: 'document.index',
      workspaceId: 1,
      payload: { documentId: 7 },
      dedupeKey: 'document:7',
    });
    assert.ok(replacement);
    assert.equal(await firstWorker.findByIdInWorkspace(replacement.id, 999_999), null);
  } finally {
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('async jobs recover interrupted attempts without exceeding the retry limit', async () => {
  const { database, root } = createDatabase();
  const jobs = new AsyncJobRepository(database);
  try {
    const retryable = await jobs.create({ type: 'recover.retry', maxAttempts: 2 });
    const exhausted = await jobs.create({ type: 'recover.fail', maxAttempts: 1 });
    await jobs.markRunning(retryable.id);
    await jobs.markRunning(exhausted.id);

    await jobs.recoverInterrupted(['recover.retry', 'recover.fail']);

    assert.equal((await jobs.findById(retryable.id))?.status, 'retrying');
    const failed = await jobs.findById(exhausted.id);
    assert.equal(failed?.status, 'failed');
    assert.ok(failed?.completedAt?.endsWith('Z'));
  } finally {
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
