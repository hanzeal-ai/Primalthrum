import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAsyncSqliteDatabase } from '../src/db/asyncDatabaseFactory';
import { type AsyncSqliteDatabase } from '../src/db/asyncSqlite';
import { AsyncAgentRepository } from '../src/services/asyncAgentRepository';
import { AsyncAgentVersionRepository } from '../src/services/asyncAgentVersionRepository';
import { AsyncUserRepository } from '../src/services/asyncUserRepository';
import { AsyncWorkspaceRepository } from '../src/services/asyncWorkspaceRepository';

function createDatabase(): { database: AsyncSqliteDatabase; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'primalthrum-async-version-'));
  return {
    database: createAsyncSqliteDatabase(join(root, 'database.sqlite')),
    root,
  };
}

test('async Agent versions preserve preview, publish, and rollback state', async () => {
  const { database, root } = createDatabase();
  const users = new AsyncUserRepository(database);
  const workspaces = new AsyncWorkspaceRepository(database);
  const agents = new AsyncAgentRepository(database, join(root, 'generated-agents'));
  const versions = new AsyncAgentVersionRepository(database);
  try {
    const owner = await users.createAdmin('version-owner@example.com', 'hash');
    const secondWorkspace = await workspaces.create(owner.id, 'Version Isolation');
    const agent = await agents.create({ name: 'Versioned Agent' }, owner.workspaceId);

    const firstPreview = await versions.createPreview(agent, owner.id);
    assert.equal(firstPreview.version.versionNumber, 1);
    assert.equal(firstPreview.version.status, 'preview');
    assert.equal(firstPreview.deployment.environment, 'preview');
    await versions.publish(agent, firstPreview.version.id, owner.id);

    const publicAgent = await agents.updateAudience(agent.id, 'public', owner.workspaceId);
    const secondPreview = await versions.createPreview(publicAgent, owner.id);
    assert.equal(secondPreview.version.versionNumber, 2);
    assert.equal(secondPreview.version.config.audience, 'public');
    await versions.publish(publicAgent, secondPreview.version.id, owner.id);

    await assert.rejects(
      versions.publish(publicAgent, 999_999, owner.id),
      /agent version not found/,
    );
    await versions.publish(publicAgent, firstPreview.version.id, owner.id, 'rollback');

    const listed = await versions.listVersions(agent.id, owner.workspaceId);
    assert.deepEqual(listed.map((version) => version.versionNumber), [2, 1]);
    assert.deepEqual(listed.map((version) => version.status), ['published', 'published']);
    assert.equal(await versions.findById(firstPreview.version.id, secondWorkspace.id), null);
    assert.equal(
      (await versions.resolveForRun(agent.id, owner.workspaceId))?.id,
      firstPreview.version.id,
    );

    const deployments = await versions.listDeployments(agent.id, owner.workspaceId);
    const activeProduction = deployments.filter((deployment) => (
      deployment.environment === 'production' && deployment.status === 'active'
    ));
    assert.equal(activeProduction.length, 1);
    assert.equal(activeProduction[0]?.versionId, firstPreview.version.id);
    assert.equal(activeProduction[0]?.trigger, 'rollback');
    assert.equal(
      deployments.filter((deployment) => (
        deployment.environment === 'preview' && deployment.status === 'active'
      )).length,
      0,
    );

    const storedConfig = await database.query<{ config_json: string }>({
      text: 'SELECT config_json FROM agent_configs WHERE agent_id = $1;',
      values: [agent.id],
    });
    assert.equal(
      (JSON.parse(storedConfig[0]?.config_json ?? '{}') as { audience?: string }).audience,
      'workspace',
    );
  } finally {
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('async Agent version allocation serializes concurrent previews', async () => {
  const { database, root } = createDatabase();
  const users = new AsyncUserRepository(database);
  const agents = new AsyncAgentRepository(database, join(root, 'generated-agents'));
  const versions = new AsyncAgentVersionRepository(database);
  try {
    const owner = await users.createAdmin('version-concurrency@example.com', 'hash');
    const agent = await agents.create({ name: 'Concurrent Version Agent' }, owner.workspaceId);
    const created = await Promise.all([
      versions.createPreview(agent, owner.id),
      versions.createPreview(agent, owner.id),
    ]);
    assert.deepEqual(
      created.map((entry) => entry.version.versionNumber).sort((left, right) => left - right),
      [1, 2],
    );
    assert.equal(
      (await versions.listDeployments(agent.id, owner.workspaceId))
        .filter((deployment) => deployment.environment === 'preview' && deployment.status === 'active')
        .length,
      1,
    );
  } finally {
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
