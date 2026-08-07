import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAsyncSqliteDatabase } from '../src/db/asyncDatabaseFactory';
import { type AsyncSqliteDatabase } from '../src/db/asyncSqlite';
import { AsyncAgentRepository } from '../src/services/asyncAgentRepository';
import { AsyncDocumentRepository } from '../src/services/asyncDocumentRepository';
import { AsyncRunRepository } from '../src/services/asyncRunRepository';
import { AsyncStreamEventRepository } from '../src/services/asyncStreamEventRepository';
import { AsyncUserRepository } from '../src/services/asyncUserRepository';

function createDatabase(): {
  database: AsyncSqliteDatabase;
  generatedAgentsDir: string;
  root: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'primalthrum-async-runtime-'));
  return {
    database: createAsyncSqliteDatabase(join(root, 'database.sqlite')),
    generatedAgentsDir: join(root, 'generated-agents'),
    root,
  };
}

test('async Agent repository creates tenant-scoped configs and unique slugs', async () => {
  const { database, generatedAgentsDir, root } = createDatabase();
  const users = new AsyncUserRepository(database);
  const agents = new AsyncAgentRepository(database, generatedAgentsDir);
  try {
    const owner = await users.createAdmin('agent-owner@example.com', 'hash');
    const first = await agents.create({
      name: 'Support Agent',
      description: 'Answers product questions',
      memoryProvider: 'postgres',
      cacheProvider: 'redis',
      ragProvider: 'pgvector',
      enabledTools: [' search ', ''],
      enabledSkills: ['support'],
      modelConfig: { default: { provider: 'openai', model: 'gpt-commercial' } },
    }, owner.workspaceId);
    const second = await agents.create({ name: 'Support Agent' }, owner.workspaceId);

    assert.equal(first.slug, 'support-agent');
    assert.equal(second.slug, 'support-agent-2');
    assert.equal(first.config.memoryProvider, 'postgres');
    assert.deepEqual(first.config.enabledTools, ['search']);
    assert.equal(first.config.audience, 'workspace');
    assert.equal(first.path, join(generatedAgentsDir, first.slug));
    assert.equal((await agents.list(owner.workspaceId)).length, 2);
    assert.equal(await agents.findByIdInWorkspace(first.id, owner.workspaceId + 1000), null);
    assert.equal((await agents.updateAudience(first.id, 'public', owner.workspaceId)).config.audience, 'public');
    assert.equal((await agents.markGenerated(first.id)).status, 'generated');
    await assert.rejects(
      agents.create({ name: 'Invalid tenant' }, owner.workspaceId + 1000),
      /FOREIGN KEY|foreign key/i,
    );
    assert.equal((await agents.list(owner.workspaceId)).length, 2);
  } finally {
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('async Run, StreamEvent, and Document repositories preserve the Agent runtime chain', async () => {
  const { database, generatedAgentsDir, root } = createDatabase();
  const users = new AsyncUserRepository(database);
  const agents = new AsyncAgentRepository(database, generatedAgentsDir);
  const runs = new AsyncRunRepository(database);
  const events = new AsyncStreamEventRepository(database);
  const documents = new AsyncDocumentRepository(database);
  try {
    const owner = await users.createAdmin('runtime-owner@example.com', 'hash');
    const agent = await agents.create({ name: 'Runtime Agent' }, owner.workspaceId);
    const run = await runs.create({
      agentId: agent.id,
      input: ' Explain the uploaded policy ',
      idempotencyKey: 'runtime:test:1',
      requestHash: 'request-hash',
      capabilitySnapshot: {
        schemaVersion: '1.0',
        selected: ['llm:mock', 'embedding:mock'],
        settings: { 'llm:mock': true, 'embedding:mock': true },
      },
    });
    assert.equal(run.input, 'Explain the uploaded policy');
    assert.equal(run.workspaceId, owner.workspaceId);
    assert.ok(run.startedAt.endsWith('Z'));
    assert.equal((await runs.findByIdempotencyKey(owner.workspaceId, 'runtime:test:1'))?.id, run.id);

    const started = await events.create({
      runId: run.id,
      eventType: 'status',
      node: 'run',
      payload: { status: 'running' },
    });
    const completed = await events.create({
      runId: run.id,
      eventType: 'done',
      payload: { status: 'completed' },
    });
    assert.ok(started.createdAt.endsWith('Z'));
    assert.deepEqual((await events.listByRunIdAfter(run.id, started.id)).map((event) => event.id), [
      completed.id,
    ]);

    const document = await documents.create(agent.id, {
      filename: ' policy.txt ',
      content: 'Policy content',
      collection: 'knowledge',
      mimeType: 'text/plain',
    });
    assert.equal(document.workspaceId, owner.workspaceId);
    assert.equal(document.sizeBytes, Buffer.byteLength('Policy content'));
    assert.equal((await documents.attachStorageRef(agent.id, document.id, 'local://policy'))?.storageRef,
      'local://policy');
    assert.equal((await documents.markStatus(agent.id, document.id, 'indexing'))?.indexStatus, 'indexing');
    assert.equal((await documents.markIndexed(agent.id, document.id))?.indexStatus, 'indexed');
    assert.equal((await documents.listByAgent(agent.id)).length, 1);

    const endedAt = '2026-08-07T09:00:00.000Z';
    const finished = await runs.updateStatus(run.id, 'completed', endedAt);
    assert.equal(finished.endedAt, endedAt);
    assert.equal((await runs.findByIdInWorkspace(run.id, owner.workspaceId))?.status, 'completed');
    assert.equal(await documents.deleteByAgentDocument(agent.id, document.id), true);
    assert.equal(await documents.deleteByAgentDocument(agent.id, document.id), false);
    await assert.rejects(
      documents.create(agent.id + 1000, { filename: 'missing.txt' }),
      /created document could not be loaded/,
    );
  } finally {
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
