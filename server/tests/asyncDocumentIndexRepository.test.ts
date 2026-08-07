import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAsyncSqliteDatabase } from '../src/db/asyncDatabaseFactory';
import { type AsyncSqliteDatabase } from '../src/db/asyncSqlite';
import { AsyncAgentRepository } from '../src/services/asyncAgentRepository';
import { AsyncDocumentIndexRepository } from '../src/services/asyncDocumentIndexRepository';
import { AsyncDocumentRepository } from '../src/services/asyncDocumentRepository';
import { AsyncUserRepository } from '../src/services/asyncUserRepository';

function createDatabase(): { database: AsyncSqliteDatabase; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'primalthrum-async-index-'));
  return {
    database: createAsyncSqliteDatabase(join(root, 'database.sqlite')),
    root,
  };
}

test('async document index preserves transactional RAG search and Agent isolation', async () => {
  const { database, root } = createDatabase();
  const users = new AsyncUserRepository(database);
  const agents = new AsyncAgentRepository(database, join(root, 'generated-agents'));
  const documents = new AsyncDocumentRepository(database);
  const index = new AsyncDocumentIndexRepository(database);
  try {
    const owner = await users.createAdmin('rag-index@example.com', 'hash');
    const agent = await agents.create({ name: 'RAG Agent' }, owner.workspaceId);
    const otherAgent = await agents.create({ name: 'Other Agent' }, owner.workspaceId);
    const document = await documents.create(agent.id, {
      filename: 'support.md',
      content: 'Account setup and refund policy',
    });
    await documents.markIndexed(agent.id, document.id);

    const entries = await index.reindex(document, [
      { chunkId: `${document.id}:0`, text: 'account setup guide' },
      { chunkId: `${document.id}:1`, text: 'refund policy details' },
    ], {
      embeddings: [[1, 0], [0, 1]],
      embeddingProvider: 'openai',
      embeddingModel: 'text-embedding-3-small',
      vectorStore: 'pgvector',
    });
    assert.equal(entries.length, 2);
    assert.equal(await index.hasCompatibleVectors(agent.id, {
      embeddingProvider: 'openai',
      embeddingModel: 'text-embedding-3-small',
      vectorStore: 'pgvector',
    }), true);
    assert.equal(await index.hasCompatibleVectors(agent.id, {
      embeddingProvider: 'openai',
      embeddingModel: 'different-model',
      vectorStore: 'pgvector',
    }), false);

    const vectorMatches = await index.searchByAgent(agent.id, 'ignored', 1, {
      queryEmbedding: [1, 0],
      embeddingProvider: 'openai',
      embeddingModel: 'text-embedding-3-small',
      vectorStore: 'pgvector',
    });
    assert.equal(vectorMatches[0]?.chunkId, `${document.id}:0`);
    const lexicalMatches = await index.searchByAgent(agent.id, 'refund', 1);
    assert.equal(lexicalMatches[0]?.chunkId, `${document.id}:1`);
    assert.deepEqual(await index.searchByAgent(otherAgent.id, 'refund', 3), []);

    await assert.rejects(
      index.reindex(document, [
        { chunkId: 'duplicate', text: 'first duplicate' },
        { chunkId: 'duplicate', text: 'second duplicate' },
      ], {
        embeddings: [],
        embeddingProvider: '',
        embeddingModel: '',
        vectorStore: '',
      }),
      /UNIQUE constraint failed|unique constraint/i,
    );
    assert.deepEqual(
      (await index.listByDocument(document.id)).map((entry) => entry.chunkId),
      [`${document.id}:0`, `${document.id}:1`],
    );
    assert.equal(await index.deleteByDocument(document.id), 2);
    assert.deepEqual(await index.listByDocument(document.id), []);
  } finally {
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
