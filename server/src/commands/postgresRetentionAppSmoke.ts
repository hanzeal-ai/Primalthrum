import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../app';
import { createSqliteDatabase } from '../db/databaseFactory';
import { PostgresDatabase } from '../db/postgres';
import { runPostgresMigrations } from '../db/postgresMigrations';
import { AsyncAgentRepository } from '../services/asyncAgentRepository';
import { AsyncConversationRepository } from '../services/asyncConversationRepository';
import { AsyncDocumentRepository } from '../services/asyncDocumentRepository';
import { AsyncJobRepository } from '../services/asyncJobRepository';
import { AsyncRetentionPolicyRepository } from '../services/asyncRetentionPolicyRepository';
import { AsyncRunRepository } from '../services/asyncRunRepository';
import { AsyncSessionRepository } from '../services/asyncSessionRepository';
import { AsyncStreamEventRepository } from '../services/asyncStreamEventRepository';
import { AsyncToolAuditRepository } from '../services/asyncToolAuditRepository';
import { AsyncUserRepository } from '../services/asyncUserRepository';
import { AsyncWorkspaceRepository } from '../services/asyncWorkspaceRepository';
import { LocalDocumentStorage } from '../services/fileStorage';
import { hashPassword } from '../services/passwordHash';
import { RetentionService } from '../services/retentionService';

const PASSWORD = 'correct horse battery staple';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const database = new PostgresDatabase({ connectionString, max: 8 });
  const root = mkdtempSync(join(tmpdir(), 'primalthrum-postgres-retention-app-'));
  const localDatabasePath = join(root, 'local.sqlite');
  const documentsRoot = join(root, 'documents');
  let server: Server | undefined;
  try {
    await runPostgresMigrations(database);
    const users = new AsyncUserRepository(database);
    const owner = await users.createUser(
      `retention-${Date.now()}@example.com`,
      hashPassword(PASSWORD),
      true,
    );
    const workspaces = new AsyncWorkspaceRepository(database);
    const workspace = await workspaces.create(owner.id, `Retention ${Date.now()}`);
    const agent = await new AsyncAgentRepository(database, join(root, 'agents')).create(
      { name: `Retention ${Date.now()}` },
      workspace.id,
    );
    const conversations = new AsyncConversationRepository(database);
    const conversation = await conversations.create(agent.id, 'Old conversation');
    const runs = new AsyncRunRepository(database);
    const run = await runs.create({ agentId: agent.id, input: 'old run' });
    await runs.attachConversation(run.id, conversation.id);
    await runs.updateStatus(run.id, 'done', '2026-01-01T00:00:00.000Z');
    const streamEvent = await new AsyncStreamEventRepository(database).create({
      runId: run.id,
      eventType: 'agent.tool.completed',
      node: 'act',
      payload: { tool: 'file_reader', status: 'allowed' },
    });
    await new AsyncToolAuditRepository(database).recordStreamEvent(streamEvent);
    const documents = new AsyncDocumentRepository(database);
    const document = await documents.create(agent.id, { filename: 'old.txt', content: 'old' });
    const storage = new LocalDocumentStorage(documentsRoot);
    const stored = storage.save({
      workspaceId: workspace.id,
      agentId: agent.id,
      documentId: document.id,
      filename: document.filename,
      content: 'old',
    });
    await documents.attachStorageRef(agent.id, document.id, stored.storageRef);
    await database.execute({
      text: 'UPDATE conversations SET created_at = $2, updated_at = $2 WHERE id = $1;',
      values: [conversation.id, '2026-01-01T00:00:00.000Z'],
    });
    await database.execute({
      text: 'UPDATE documents SET created_at = $2 WHERE id = $1;',
      values: [document.id, '2026-01-01T00:00:00.000Z'],
    });
    await new AsyncJobRepository(database).create({
      type: 'document.index',
      workspaceId: workspace.id,
      payload: { documentId: document.id },
    });

    const policies = new AsyncRetentionPolicyRepository(
      database,
      () => new Date('2026-08-01T12:00:00.000Z'),
    );
    await policies.update({
      workspaceId: workspace.id,
      conversationDays: 30,
      runDays: 7,
      documentDays: 30,
      actorUserId: owner.id,
    });
    const outcome = await new RetentionService(policies, storage).enforce(workspace.id, owner.id);
    if (
      Number(outcome.event.result.conversations) !== 1
      || Number(outcome.event.result.runs) !== 1
      || Number(outcome.event.result.documents) !== 1
      || outcome.filesDeleted !== 1
      || existsSync(stored.absolutePath)
    ) {
      throw new Error('PostgreSQL retention enforcement result is inconsistent');
    }
    const evidence = await database.query<{
      conversations: number | string;
      runs: number | string;
      documents: number | string;
      audits: number | string;
      file_deletions: number | string;
      failed_jobs: number | string;
    }>({
      text: `
        SELECT
          (SELECT COUNT(*) FROM conversations WHERE id = $1) AS conversations,
          (SELECT COUNT(*) FROM runs WHERE id = $2) AS runs,
          (SELECT COUNT(*) FROM documents WHERE id = $3) AS documents,
          (SELECT COUNT(*) FROM retained_tool_audit_logs WHERE workspace_id = $4) AS audits,
          (SELECT COUNT(*) FROM retention_file_deletions
            WHERE workspace_id = $4 AND status = 'completed') AS file_deletions,
          (SELECT COUNT(*) FROM jobs
            WHERE workspace_id = $4 AND type = 'document.index' AND status = 'failed') AS failed_jobs;
      `,
      values: [conversation.id, run.id, document.id, workspace.id],
    });
    const row = evidence[0];
    if (
      Number(row?.conversations) !== 0
      || Number(row?.runs) !== 0
      || Number(row?.documents) !== 0
      || Number(row?.audits) !== 1
      || Number(row?.file_deletions) !== 1
      || Number(row?.failed_jobs) !== 1
    ) {
      throw new Error('PostgreSQL retention evidence was not committed atomically');
    }

    const principal = await workspaces.principalForUser(owner.id, workspace.id);
    if (!principal) throw new Error('PostgreSQL retention principal was not created');
    const session = await new AsyncSessionRepository(database).create(principal);
    const app = createApp({
      dbPath: localDatabasePath,
      documentStorageDir: documentsRoot,
      generatedAgentsDir: join(root, 'generated-agents'),
      identityDatabase: database,
      runtimeDatabase: database,
      logger: { log: () => undefined },
      startBackgroundSchedulers: false,
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server?.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('retention app server did not start');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/settings/retention`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    if (response.status !== 200) throw new Error(`PostgreSQL retention settings returned ${response.status}`);
    const state = await response.json() as {
      policy: { conversationDays: number | null };
      events: Array<{ eventType: string }>;
    };
    if (state.policy.conversationDays !== 30 || state.events.length < 2) {
      throw new Error('application did not compose the PostgreSQL retention store');
    }

    const local = createSqliteDatabase(localDatabasePath).query<{
      policies: number;
      events: number;
      files: number;
    }>(`
      SELECT
        (SELECT COUNT(*) FROM workspace_retention_policies) AS policies,
        (SELECT COUNT(*) FROM retention_events) AS events,
        (SELECT COUNT(*) FROM retention_file_deletions) AS files;
    `)[0];
    if (local?.policies || local?.events || local?.files) {
      throw new Error('retention lifecycle leaked into local SQLite');
    }
    process.stdout.write('postgres retention application composition smoke passed\n');
  } finally {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'postgres retention smoke failed'}\n`);
  process.exitCode = 1;
});
