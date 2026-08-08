import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../app';
import { createSqliteDatabase } from '../db/databaseFactory';
import { PostgresDatabase } from '../db/postgres';
import { runPostgresMigrations } from '../db/postgresMigrations';
import { AsyncAccountDeletionService } from '../services/asyncAccountDeletionService';
import { AsyncAccountPrivacyRepository } from '../services/asyncAccountPrivacyRepository';
import { AsyncAgentRepository } from '../services/asyncAgentRepository';
import { AsyncDocumentRepository } from '../services/asyncDocumentRepository';
import { AsyncSessionRepository } from '../services/asyncSessionRepository';
import { AsyncUserRepository } from '../services/asyncUserRepository';
import { AsyncWorkspaceRepository } from '../services/asyncWorkspaceRepository';
import { LocalDocumentStorage } from '../services/fileStorage';
import { hashPassword } from '../services/passwordHash';

const PASSWORD = 'correct horse battery staple';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const database = new PostgresDatabase({ connectionString, max: 8 });
  const root = mkdtempSync(join(tmpdir(), 'primalthrum-postgres-account-privacy-'));
  const localDatabasePath = join(root, 'local.sqlite');
  const documentsRoot = join(root, 'documents');
  let server: Server | undefined;
  try {
    await runPostgresMigrations(database);
    let now = new Date('2026-08-01T12:00:00.000Z');
    const email = `privacy-${Date.now()}@example.com`;
    const owner = await new AsyncUserRepository(database).createUser(
      email,
      hashPassword(PASSWORD),
      true,
    );
    const workspaces = new AsyncWorkspaceRepository(database);
    const workspace = await workspaces.create(owner.id, `Privacy ${Date.now()}`);
    const principal = await workspaces.principalForUser(owner.id, workspace.id);
    if (!principal) throw new Error('PostgreSQL privacy principal was not created');
    const session = await new AsyncSessionRepository(database).create(principal);
    const agent = await new AsyncAgentRepository(database, join(root, 'agents')).create(
      { name: `Privacy Agent ${Date.now()}` },
      workspace.id,
    );
    const documents = new AsyncDocumentRepository(database);
    const document = await documents.create(agent.id, {
      filename: 'knowledge.txt',
      content: 'portable private knowledge',
    });
    const storage = new LocalDocumentStorage(documentsRoot);
    const stored = storage.save({
      workspaceId: workspace.id,
      agentId: agent.id,
      documentId: document.id,
      filename: document.filename,
      content: 'portable private knowledge',
    });
    await documents.attachStorageRef(agent.id, document.id, stored.storageRef);

    const app = createApp({
      dbPath: localDatabasePath,
      documentStorageDir: documentsRoot,
      generatedAgentsDir: join(root, 'generated-agents'),
      identityDatabase: database,
      runtimeDatabase: database,
      accountPrivacyNow: () => now,
      accountDeletionGracePeriodMs: 60_000,
      logger: { log: () => undefined },
      startBackgroundSchedulers: false,
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server?.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('account privacy app did not start');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const headers = {
      authorization: `Bearer ${session.token}`,
      'content-type': 'application/json',
    };

    const exported = await fetch(`${baseUrl}/api/settings/privacy/export`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ password: PASSWORD, scope: 'workspace' }),
    });
    if (exported.status !== 200) throw new Error(`PostgreSQL privacy export returned ${exported.status}`);
    const archive = await exported.json() as {
      workspace?: { documents?: Array<{ content?: string }> };
    };
    if (archive.workspace?.documents?.[0]?.content !== 'portable private knowledge') {
      throw new Error('PostgreSQL privacy export omitted document content');
    }
    if (/password_hash|token_hash|secret_ref/.test(JSON.stringify(archive))) {
      throw new Error('PostgreSQL privacy export exposed credentials');
    }

    const scheduled = await fetch(`${baseUrl}/api/settings/privacy/deletion`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ password: PASSWORD, confirmEmail: email }),
    });
    if (scheduled.status !== 202) throw new Error(`PostgreSQL deletion request returned ${scheduled.status}`);
    const request = await scheduled.json() as { requestId: string };
    now = new Date('2026-08-01T12:02:00.000Z');
    const privacy = new AsyncAccountPrivacyRepository(database, () => now);
    const deletion = new AsyncAccountDeletionService(
      database,
      privacy,
      storage,
      () => now,
      60_000,
    );
    const outcome = await deletion.execute(request.requestId);
    if (
      outcome.status !== 'completed'
      || Number(outcome.anonymizedWorkspaces) !== 1
      || Number(outcome.deletedDocuments) !== 1
      || existsSync(stored.absolutePath)
    ) {
      throw new Error('PostgreSQL account deletion result is inconsistent');
    }

    const evidence = await database.query<{
      email: string;
      deleted_at: string | Date | null;
      workspace_deleted_at: string | Date | null;
      agents: number | string;
      events: number | string;
      status: string;
    }>({
      text: `
        SELECT user_record.email, user_record.deleted_at,
          workspace.deleted_at AS workspace_deleted_at,
          (SELECT COUNT(*) FROM agents WHERE workspace_id = $2) AS agents,
          (SELECT COUNT(*) FROM account_privacy_events WHERE request_id = $3) AS events,
          request.status
        FROM users user_record, workspaces workspace, account_privacy_requests request
        WHERE user_record.id = $1 AND workspace.id = $2 AND request.request_id = $3;
      `,
      values: [owner.id, workspace.id, request.requestId],
    });
    const row = evidence[0];
    if (
      !row?.email.startsWith('deleted+')
      || !row.deleted_at
      || !row.workspace_deleted_at
      || Number(row.agents) !== 0
      || Number(row.events) < 3
      || row.status !== 'completed'
    ) {
      throw new Error('PostgreSQL account privacy evidence is inconsistent');
    }
    const revoked = await fetch(`${baseUrl}/api/settings/privacy`, { headers });
    if (revoked.status !== 401) throw new Error('deleted account session remained active');

    const local = createSqliteDatabase(localDatabasePath).query<{
      requests: number;
      events: number;
      users: number;
    }>(`
      SELECT
        (SELECT COUNT(*) FROM account_privacy_requests) AS requests,
        (SELECT COUNT(*) FROM account_privacy_events) AS events,
        (SELECT COUNT(*) FROM users) AS users;
    `)[0];
    if (local?.requests || local?.events || local?.users) {
      throw new Error('account privacy lifecycle leaked into local SQLite');
    }
    process.stdout.write('postgres account privacy application composition smoke passed\n');
  } finally {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'postgres account privacy smoke failed'}\n`);
  process.exitCode = 1;
});
