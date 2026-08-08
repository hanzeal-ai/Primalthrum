import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAsyncSqliteDatabase } from '../src/db/asyncDatabaseFactory';
import { type AsyncSqliteDatabase } from '../src/db/asyncSqlite';
import { AsyncApiKeyRepository } from '../src/services/asyncApiKeyRepository';
import { AsyncUserRepository } from '../src/services/asyncUserRepository';
import { AsyncWorkspaceRepository } from '../src/services/asyncWorkspaceRepository';

function createDatabase(): { database: AsyncSqliteDatabase; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'primalthrum-async-api-keys-'));
  return {
    database: createAsyncSqliteDatabase(join(root, 'database.sqlite')),
    root,
  };
}

test('async API keys are hashed, tenant-scoped, audited, expiring, and revocable', async () => {
  const { database, root } = createDatabase();
  let now = new Date('2026-08-01T00:00:00.000Z');
  const users = new AsyncUserRepository(database);
  const workspaces = new AsyncWorkspaceRepository(database);
  const keys = new AsyncApiKeyRepository(database, () => now);
  try {
    const owner = await users.createUser('async-api-key@example.com', 'hash', true);
    const workspace = await workspaces.create(owner.id, 'Async API Keys');
    const second = await workspaces.create(owner.id, 'Second API Keys');
    const created = await keys.create({
      workspaceId: workspace.id,
      name: 'Production runtime',
      scopes: ['agents:run', 'agents:read', 'agents:run'],
      expiresInDays: 1,
      createdByUserId: owner.id,
    });
    assert.match(created.token, /^ptk_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+$/);
    assert.deepEqual(created.scopes, ['agents:read', 'agents:run']);
    const stored = await database.query<{ token_hash: string }>({
      text: 'SELECT token_hash FROM workspace_api_keys WHERE id = $1;',
      values: [created.id],
    });
    assert.notEqual(stored[0]?.token_hash, created.token);
    assert.equal((await keys.resolve(created.token))?.user.workspaceId, workspace.id);
    await keys.recordUse(created.id, workspace.id, 'get', '/api/agents?secret=ignored');
    const listed = (await keys.list(workspace.id))[0];
    assert.equal(listed?.lastUsedMethod, 'GET');
    assert.equal(listed?.lastUsedPath, '/api/agents');
    await assert.rejects(keys.revoke(second.id, created.id), /API key not found/);
    assert.ok(await keys.resolve(created.token));
    now = new Date('2026-08-03T00:00:00.000Z');
    assert.equal(await keys.resolve(created.token), null);
    await keys.revoke(workspace.id, created.id);
    assert.ok((await keys.list(workspace.id))[0]?.revokedAt);
    assert.equal(await keys.resolve(created.token), null);
    const usage = await database.query<{ count: number }>({
      text: 'SELECT COUNT(*) AS count FROM api_key_usage_events WHERE api_key_id = $1;',
      values: [created.id],
    });
    assert.equal(Number(usage[0]?.count), 1);
  } finally {
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('async API key creation serializes the active key limit', async () => {
  const { database, root } = createDatabase();
  const users = new AsyncUserRepository(database);
  const workspaces = new AsyncWorkspaceRepository(database);
  const keys = new AsyncApiKeyRepository(database, () => new Date('2026-08-01T00:00:00.000Z'));
  try {
    const owner = await users.createUser('async-api-key-limit@example.com', 'hash', true);
    const workspace = await workspaces.create(owner.id, 'API Key Limit');
    for (let index = 0; index < 19; index += 1) {
      await keys.create(input(workspace.id, owner.id, index));
    }
    const results = await Promise.allSettled([
      keys.create(input(workspace.id, owner.id, 19)),
      keys.create(input(workspace.id, owner.id, 20)),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(
      results.some((result) => (
        result.status === 'rejected'
        && result.reason instanceof Error
        && /more than 20 active API keys/.test(result.reason.message)
      )),
      true,
    );
    assert.equal((await keys.list(workspace.id)).length, 20);
  } finally {
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function input(workspaceId: number, userId: number, index: number) {
  return {
    workspaceId,
    name: `Runtime key ${index}`,
    scopes: ['agents:read'],
    expiresInDays: 30,
    createdByUserId: userId,
  };
}
