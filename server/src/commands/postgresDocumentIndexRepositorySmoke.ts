import { randomUUID } from 'node:crypto';

import { PostgresDatabase } from '../db/postgres';
import { runPostgresMigrations } from '../db/postgresMigrations';
import { AsyncAgentRepository } from '../services/asyncAgentRepository';
import { AsyncDocumentIndexRepository } from '../services/asyncDocumentIndexRepository';
import { AsyncDocumentRepository } from '../services/asyncDocumentRepository';
import { AsyncUserRepository } from '../services/asyncUserRepository';
import { AsyncWorkspaceRepository } from '../services/asyncWorkspaceRepository';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');

  const database = new PostgresDatabase({ connectionString, max: 4 });
  const marker = randomUUID();
  const users = new AsyncUserRepository(database);
  const workspaces = new AsyncWorkspaceRepository(database);
  const agents = new AsyncAgentRepository(database, '/tmp/primalthrum-generated-agents');
  const documents = new AsyncDocumentRepository(database);
  const index = new AsyncDocumentIndexRepository(database);
  let workspaceId: number | null = null;
  try {
    await runPostgresMigrations(database);
    const owner = await users.createUser(`rag-${marker}@example.com`, 'hash', true);
    const workspace = await workspaces.create(owner.id, `RAG ${marker}`);
    workspaceId = workspace.id;
    const agent = await agents.create({ name: `RAG ${marker}` }, workspaceId);
    const otherAgent = await agents.create({ name: `Other ${marker}` }, workspaceId);
    const document = await documents.create(agent.id, {
      filename: 'postgres-rag.md',
      content: 'setup and refund knowledge',
    });
    await documents.markIndexed(agent.id, document.id);
    await index.reindex(document, [
      { chunkId: `${document.id}:0`, text: 'setup guide' },
      { chunkId: `${document.id}:1`, text: 'refund policy' },
    ], {
      embeddings: [[1, 0], [0, 1]],
      embeddingProvider: 'openai',
      embeddingModel: 'text-embedding',
      vectorStore: 'pgvector',
    });
    const compatible = await index.hasCompatibleVectors(agent.id, {
      embeddingProvider: 'openai',
      embeddingModel: 'text-embedding',
      vectorStore: 'pgvector',
    });
    const matches = await index.searchByAgent(agent.id, 'ignored', 1, {
      queryEmbedding: [0, 1],
      embeddingProvider: 'openai',
      embeddingModel: 'text-embedding',
      vectorStore: 'pgvector',
    });
    const isolated = await index.searchByAgent(otherAgent.id, 'refund', 3);
    try {
      await index.reindex(document, [
        { chunkId: 'duplicate', text: 'first' },
        { chunkId: 'duplicate', text: 'second' },
      ], {
        embeddings: [],
        embeddingProvider: '',
        embeddingModel: '',
        vectorStore: '',
      });
      throw new Error('duplicate PostgreSQL RAG chunks unexpectedly succeeded');
    } catch (error) {
      if (error instanceof Error && error.message === 'duplicate PostgreSQL RAG chunks unexpectedly succeeded') {
        throw error;
      }
      if (postgresErrorCode(error) !== '23505') throw error;
    }
    const retained = await index.listByDocument(document.id);
    if (
      !compatible
      || matches[0]?.chunkId !== `${document.id}:1`
      || isolated.length !== 0
      || retained.length !== 2
      || retained[0]?.chunkId !== `${document.id}:0`
    ) {
      throw new Error('PostgreSQL RAG index state is inconsistent');
    }
    process.stdout.write('postgres document index repository smoke passed\n');
  } finally {
    if (workspaceId) {
      await database.execute({
        text: 'DELETE FROM workspaces WHERE id = $1;',
        values: [workspaceId],
      }).catch(() => undefined);
    }
    await database.close();
  }
}

function postgresErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'postgres RAG smoke failed'}\n`);
  process.exitCode = 1;
});
