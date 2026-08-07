import { randomUUID } from 'node:crypto';

import { PostgresDatabase } from '../db/postgres';
import { runPostgresMigrations } from '../db/postgresMigrations';
import { DEFAULT_WORKSPACE_ID } from '../db/workspaceDefaults';
import { AsyncAgentRepository } from '../services/asyncAgentRepository';
import { AsyncDocumentRepository } from '../services/asyncDocumentRepository';
import { AsyncRunRepository } from '../services/asyncRunRepository';
import { AsyncStreamEventRepository } from '../services/asyncStreamEventRepository';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');

  const database = new PostgresDatabase({ connectionString, max: 4 });
  const marker = randomUUID();
  const agents = new AsyncAgentRepository(database, '/tmp/primalthrum-generated-agents');
  const runs = new AsyncRunRepository(database);
  const events = new AsyncStreamEventRepository(database);
  const documents = new AsyncDocumentRepository(database);
  let agentId: number | null = null;
  try {
    await runPostgresMigrations(database);
    const agent = await agents.create({
      name: `Postgres Runtime ${marker}`,
      memoryProvider: 'postgres',
      cacheProvider: 'redis',
      ragProvider: 'pgvector',
      audience: 'public',
    }, DEFAULT_WORKSPACE_ID);
    agentId = agent.id;
    const run = await runs.create({
      agentId: agent.id,
      input: "parameterized runtime input ' value",
      idempotencyKey: `runtime:${marker}`,
      requestHash: marker,
    });
    const event = await events.create({
      runId: run.id,
      eventType: 'done',
      node: 'run',
      payload: { status: 'completed', marker },
    });
    const document = await documents.create(agent.id, {
      filename: 'runtime.txt',
      content: 'PostgreSQL Agent runtime document',
      collection: 'smoke',
    });
    await documents.attachStorageRef(agent.id, document.id, `s3://smoke/${marker}`);
    await documents.markIndexed(agent.id, document.id);
    const finished = await runs.updateStatus(run.id, 'completed', new Date().toISOString());

    if (
      (await agents.findBySlug(agent.slug))?.id !== agent.id
      || (await runs.findByIdempotencyKey(DEFAULT_WORKSPACE_ID, `runtime:${marker}`))?.id !== run.id
      || (await events.listByRunId(run.id))[0]?.id !== event.id
      || (await documents.findByAgentDocument(agent.id, document.id))?.indexStatus !== 'indexed'
      || !event.createdAt.endsWith('Z')
      || !finished.endedAt?.endsWith('Z')
    ) {
      throw new Error('PostgreSQL Agent runtime repository chain is inconsistent');
    }
    process.stdout.write('postgres Agent runtime repository smoke passed\n');
  } finally {
    if (agentId) {
      await database.execute({
        text: 'DELETE FROM agents WHERE id = $1;',
        values: [agentId],
      }).catch(() => undefined);
    }
    await database.close();
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'postgres Agent runtime smoke failed'}\n`);
  process.exitCode = 1;
});
