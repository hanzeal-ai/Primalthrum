import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAsyncSqliteDatabase } from '../src/db/asyncDatabaseFactory';
import { type AsyncSqliteDatabase } from '../src/db/asyncSqlite';
import { AsyncProviderConfigRepository } from '../src/services/asyncProviderConfigRepository';
import { AsyncSecretVault } from '../src/services/asyncSecretVault';
import { AsyncUserRepository } from '../src/services/asyncUserRepository';
import { AsyncWorkspaceRepository } from '../src/services/asyncWorkspaceRepository';

function createDatabase(): { database: AsyncSqliteDatabase; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'primalthrum-async-provider-'));
  return {
    database: createAsyncSqliteDatabase(join(root, 'database.sqlite')),
    root,
  };
}

test('async ProviderConfig stores encrypted tenant-scoped secrets and rotates them', async () => {
  const { database, root } = createDatabase();
  const users = new AsyncUserRepository(database);
  const workspaces = new AsyncWorkspaceRepository(database);
  const secrets = new AsyncSecretVault(database);
  const providers = new AsyncProviderConfigRepository(database, secrets);
  try {
    const owner = await users.createAdmin('provider-owner@example.com', 'hash');
    const secondWorkspace = await workspaces.create(owner.id, 'Second Provider Workspace');
    const provider = await providers.create({
      name: 'Primary OpenAI',
      type: 'llm',
      config: {
        provider: 'openai',
        model: 'gpt-commercial',
        baseUrl: 'https://api.openai.com/v1/',
      },
      secret: "sk-secret-'parameter",
    }, owner.workspaceId);

    assert.ok(provider.secretRef.startsWith('secret://local/'));
    assert.equal(provider.config.baseUrl, 'https://api.openai.com/v1');
    assert.equal(await secrets.read(provider.secretRef, owner.workspaceId), "sk-secret-'parameter");
    await assert.rejects(
      secrets.read(provider.secretRef, secondWorkspace.id),
      /provider secret not found/,
    );
    const encryptedRows = await database.query<{ ciphertext: string }>({
      text: 'SELECT ciphertext FROM secrets WHERE secret_ref = $1;',
      values: [provider.secretRef],
    });
    assert.notEqual(encryptedRows[0]?.ciphertext, "sk-secret-'parameter");

    const updated = await providers.update(provider.id, {
      config: { provider: 'openai', model: 'gpt-next' },
      secret: 'rotated-secret',
    }, owner.workspaceId);
    assert.equal(updated?.secretRef, provider.secretRef);
    assert.equal(updated?.config.model, 'gpt-next');
    assert.equal(await secrets.read(provider.secretRef, owner.workspaceId), 'rotated-secret');
    assert.equal((await providers.list(owner.workspaceId)).length, 1);
    assert.equal(await providers.findById(provider.id, secondWorkspace.id), null);
  } finally {
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('async ProviderConfig transaction rolls back a new secret when provider creation fails', async () => {
  const { database, root } = createDatabase();
  const users = new AsyncUserRepository(database);
  const providers = new AsyncProviderConfigRepository(database);
  try {
    const owner = await users.createAdmin('provider-rollback@example.com', 'hash');
    await providers.create({
      name: 'Unique Provider',
      type: 'embedding',
      config: { provider: 'openai', model: 'text-embedding' },
      secret: 'first-secret',
    }, owner.workspaceId);
    const before = Number((await database.query<{ count: number }>({
      text: 'SELECT COUNT(*) AS count FROM secrets WHERE workspace_id = $1;',
      values: [owner.workspaceId],
    }))[0]?.count ?? 0);

    await assert.rejects(
      providers.create({
        name: 'Unique Provider',
        type: 'embedding',
        secret: 'orphan-secret',
      }, owner.workspaceId),
      /UNIQUE constraint failed|unique constraint/i,
    );
    const after = Number((await database.query<{ count: number }>({
      text: 'SELECT COUNT(*) AS count FROM secrets WHERE workspace_id = $1;',
      values: [owner.workspaceId],
    }))[0]?.count ?? 0);
    assert.equal(after, before);
  } finally {
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
