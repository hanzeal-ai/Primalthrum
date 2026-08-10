import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createApp } from '../src/app';
import { createSqliteDatabase } from '../src/db/databaseFactory';
import { closeApp } from '../src/services/appLifecycle';
import { JobRepository } from '../src/services/jobRepository';

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition was not met before timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('application cleanup stops polling before another job can be claimed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'primalthrum-worker-lifecycle-'));
  const database = createSqliteDatabase(join(root, 'platform.sqlite'));
  const app = createApp({
    database,
    documentStorageDir: join(root, 'documents'),
    generatedAgentsDir: join(root, 'generated-agents'),
    jobPollIntervalMs: 25,
    logger: { log: () => undefined },
  });
  const jobs = new JobRepository(database);

  try {
    const processed = jobs.create({
      type: 'document.index',
      maxAttempts: 1,
      payload: { agentId: 404, documentId: 404 },
    });
    await waitFor(() => jobs.findById(processed.id)?.status === 'failed');

    await closeApp(app);
    const queued = jobs.create({
      type: 'document.index',
      maxAttempts: 1,
      payload: { agentId: 405, documentId: 405 },
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(jobs.findById(queued.id)?.status, 'queued');
  } finally {
    await closeApp(app);
    rmSync(root, { recursive: true, force: true });
  }
});
