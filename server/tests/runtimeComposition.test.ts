import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createApp } from '../src/app';
import { createAsyncSqliteDatabase } from '../src/db/asyncDatabaseFactory';
import { createSqliteDatabase } from '../src/db/databaseFactory';
import { closeApp } from '../src/services/appLifecycle';

test('createApp preserves the explicit synchronous database fallback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'primalthrum-sync-runtime-'));
  let server: Server | undefined;
  try {
    const database = createSqliteDatabase(join(root, 'platform.sqlite'));
    server = createApp({
      database,
      documentStorageDir: join(root, 'documents'),
      generatedAgentsDir: join(root, 'generated-agents'),
      logger: { log: () => undefined },
      startBackgroundSchedulers: false,
    }).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server?.once('listening', resolve));
    const address = server.address();
    assert(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const setup = await fetch(`${baseUrl}/api/setup/admin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'sync-runtime@example.com',
        password: 'correct horse battery staple',
      }),
    });
    assert.equal(setup.status, 201);
    const session = await setup.json() as { session: { token: string } };

    const created = await fetch(`${baseUrl}/api/agents`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.session.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'Synchronous Runtime Agent' }),
    });
    assert.equal(created.status, 201);
    assert.equal((await created.json() as { name: string }).name, 'Synchronous Runtime Agent');
  } finally {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test('createApp uses an injected async database without creating a SQLite fallback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'primalthrum-async-only-runtime-'));
  const fallbackPath = join(root, 'must-not-exist.sqlite');
  const database = createAsyncSqliteDatabase(join(root, 'async-runtime.sqlite'));
  let server: Server | undefined;
  const app = createApp({
    dbPath: fallbackPath,
    identityDatabase: database,
    runtimeDatabase: database,
    documentStorageDir: join(root, 'documents'),
    generatedAgentsDir: join(root, 'generated-agents'),
    logger: { log: () => undefined },
    startBackgroundSchedulers: false,
  });
  try {
    assert.equal(existsSync(fallbackPath), false);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server?.once('listening', resolve));
    const address = server.address();
    assert(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const setupStatus = await fetch(`${baseUrl}/api/setup/status`);
    assert.equal(setupStatus.status, 200);
    const readiness = await fetch(`${baseUrl}/ready`);
    assert.equal(readiness.status, 503);
    const report = await readiness.json() as {
      checks: Array<{ name: string; status: string }>;
    };
    assert.equal(
      report.checks.find((check) => check.name === 'database')?.status,
      'ok',
    );
    assert.equal(existsSync(fallbackPath), false);
  } finally {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    await closeApp(app);
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
