import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../app';
import { PostgresDatabase } from '../db/postgres';
import { runPostgresMigrations } from '../db/postgresMigrations';
import { AsyncApiKeyRepository } from '../services/asyncApiKeyRepository';
import { AsyncUserRepository } from '../services/asyncUserRepository';
import { AsyncWorkspaceRepository } from '../services/asyncWorkspaceRepository';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const database = new PostgresDatabase({ connectionString, max: 6 });
  const root = mkdtempSync(join(tmpdir(), 'primalthrum-postgres-api-key-app-'));
  let server: Server | undefined;
  try {
    await runPostgresMigrations(database);
    const marker = randomUUID();
    const users = new AsyncUserRepository(database);
    const workspaces = new AsyncWorkspaceRepository(database);
    const keys = new AsyncApiKeyRepository(database);
    const owner = await users.createUser(`api-key-${marker}@example.com`, 'hash', true);
    const workspace = await workspaces.create(owner.id, `API Key ${marker}`);
    const created = await keys.create({
      workspaceId: workspace.id,
      name: 'PostgreSQL runtime',
      scopes: ['agents:read'],
      expiresInDays: 30,
      createdByUserId: owner.id,
    });
    const app = createApp({
      dbPath: join(root, 'local.sqlite'),
      documentStorageDir: join(root, 'documents'),
      generatedAgentsDir: join(root, 'generated-agents'),
      identityDatabase: database,
      runtimeDatabase: database,
      logger: { log: () => undefined },
      startBackgroundSchedulers: false,
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server?.once('listening', resolve));
    const address = server.address();
    assert(address && typeof address === 'object');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/agents`, {
      headers: { authorization: `Bearer ${created.token}` },
    });
    if (response.status !== 200) {
      throw new Error(`PostgreSQL API key request returned ${response.status}`);
    }
    const record = (await keys.list(workspace.id))[0];
    const events = await database.query<{ count: number | string }>({
      text: 'SELECT COUNT(*) AS count FROM api_key_usage_events WHERE api_key_id = $1;',
      values: [created.id],
    });
    if (
      record?.lastUsedMethod !== 'GET'
      || record.lastUsedPath !== '/api/agents'
      || Number(events[0]?.count) !== 1
    ) {
      throw new Error('PostgreSQL API key usage evidence is inconsistent');
    }
    await keys.revoke(workspace.id, created.id);
    const revoked = await fetch(`http://127.0.0.1:${address.port}/api/agents`, {
      headers: { authorization: `Bearer ${created.token}` },
    });
    if (revoked.status !== 401) {
      throw new Error('PostgreSQL revoked API key remained authorized');
    }
    process.stdout.write('postgres API key application composition smoke passed\n');
  } finally {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'postgres API key app smoke failed'}\n`);
  process.exitCode = 1;
});
