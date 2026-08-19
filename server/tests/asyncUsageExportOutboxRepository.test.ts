import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAsyncSqliteDatabase } from '../src/db/asyncDatabaseFactory';
import { type AsyncSqliteDatabase } from '../src/db/asyncSqlite';
import { AsyncUsageExportOutboxRepository } from '../src/services/asyncUsageExportOutboxRepository';
import { AsyncUsageRatingRepository } from '../src/services/asyncUsageRatingRepository';
import { AsyncUserRepository } from '../src/services/asyncUserRepository';
import { AsyncWorkspaceRepository } from '../src/services/asyncWorkspaceRepository';
import { UsageExportDispatcher } from '../src/services/usageExportDispatcher';
import { type UsageMeterExportPayload } from '../src/services/usageMeterExporter';

const NOW = new Date(Date.now() + 60_000);
const logger = { log: () => undefined };

function createDatabase(): { database: AsyncSqliteDatabase; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'primalthrum-async-usage-export-'));
  return {
    database: createAsyncSqliteDatabase(join(root, 'database.sqlite')),
    root,
  };
}

test('async usage export claims one event once across competing dispatchers', async () => {
  const { database, root } = createDatabase();
  const users = new AsyncUserRepository(database);
  const workspaces = new AsyncWorkspaceRepository(database);
  const ratings = new AsyncUsageRatingRepository(database, () => NOW);
  const outbox = new AsyncUsageExportOutboxRepository(database, () => NOW);
  try {
    const owner = await users.createUser('async-export@example.com', 'hash', true);
    const workspace = await workspaces.create(owner.id, 'Usage Export');
    await ratings.rate({
      workspaceId: workspace.id,
      idempotencyKey: 'export:input',
      meter: 'llm.input_tokens',
      quantity: 100,
      occurredAt: NOW.toISOString(),
    });
    const delivered: UsageMeterExportPayload[] = [];
    const exporter = {
      destination: 'primary',
      send: async (payload: UsageMeterExportPayload) => { delivered.push(payload); },
    };
    await Promise.all([
      new UsageExportDispatcher(outbox, exporter, logger).drain(),
      new UsageExportDispatcher(outbox, exporter, logger).drain(),
    ]);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0]?.workspaceId, workspace.id);
    assert.equal(delivered[0]?.createdAt.endsWith('Z'), true);
    const rows = await database.query<{ status: string; attempts: number }>({
      text: 'SELECT status, attempts FROM usage_meter_exports;',
    });
    assert.deepEqual(rows, [{ status: 'delivered', attempts: 1 }]);
    assert.equal(await outbox.nextAttemptDelayMs('primary'), null);
  } finally {
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('async usage export retains bounded retry evidence', async () => {
  const { database, root } = createDatabase();
  const users = new AsyncUserRepository(database);
  const workspaces = new AsyncWorkspaceRepository(database);
  const ratings = new AsyncUsageRatingRepository(database, () => NOW);
  const outbox = new AsyncUsageExportOutboxRepository(database, () => NOW);
  try {
    const owner = await users.createUser('async-export-failure@example.com', 'hash', true);
    const workspace = await workspaces.create(owner.id, 'Usage Export Failure');
    await ratings.rate({
      workspaceId: workspace.id,
      idempotencyKey: 'export:failure',
      meter: 'hosted.runs',
      quantity: 1,
      occurredAt: NOW.toISOString(),
    });
    const dispatcher = new UsageExportDispatcher(outbox, {
      destination: 'primary',
      send: async () => { throw new Error('sink unavailable'); },
    }, logger);
    await dispatcher.drain();
    const rows = await database.query<{
      status: string;
      attempts: number;
      last_error: string;
      next_attempt_at: string;
    }>({
      text: `
        SELECT status, attempts, last_error, next_attempt_at
        FROM usage_meter_exports;
      `,
    });
    assert.equal(rows[0]?.status, 'failed');
    assert.equal(rows[0]?.attempts, 1);
    assert.equal(rows[0]?.last_error, 'sink unavailable');
    assert.equal(
      rows[0]?.next_attempt_at,
      new Date(NOW.getTime() + 1_000).toISOString(),
    );
    assert.equal(await outbox.nextAttemptDelayMs('primary'), 1000);
  } finally {
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
