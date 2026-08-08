import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../app';
import { createSqliteDatabase } from '../db/databaseFactory';
import { PostgresDatabase } from '../db/postgres';
import { runPostgresMigrations } from '../db/postgresMigrations';
import { AsyncSessionRepository } from '../services/asyncSessionRepository';
import { AsyncUserRepository } from '../services/asyncUserRepository';
import { AsyncWorkspaceRepository } from '../services/asyncWorkspaceRepository';
import { hashPassword } from '../services/passwordHash';

const PASSWORD = 'correct horse battery staple';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const database = new PostgresDatabase({ connectionString, max: 8 });
  const root = mkdtempSync(join(tmpdir(), 'primalthrum-postgres-ownership-app-'));
  const localDatabasePath = join(root, 'local.sqlite');
  let server: Server | undefined;
  try {
    await runPostgresMigrations(database);
    const marker = randomUUID();
    const users = new AsyncUserRepository(database);
    const workspaces = new AsyncWorkspaceRepository(database);
    const sessions = new AsyncSessionRepository(database);
    const owner = await users.createUser(
      `ownership-owner-${marker}@example.com`,
      hashPassword(PASSWORD),
      true,
    );
    const firstTarget = await users.createUser(`ownership-first-${marker}@example.com`, 'hash', true);
    const secondTarget = await users.createUser(`ownership-second-${marker}@example.com`, 'hash', true);
    const workspace = await workspaces.create(owner.id, `Ownership App ${marker}`);
    for (const target of [firstTarget, secondTarget]) {
      await database.execute({
        text: `
          INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
          VALUES ($1, $2, 'developer', 'active');
        `,
        values: [workspace.id, target.id],
      });
    }
    const principal = await workspaces.principalForUser(owner.id, workspace.id);
    if (!principal) throw new Error('PostgreSQL ownership principal was not created');
    const session = await sessions.create(principal);
    const app = createApp({
      dbPath: localDatabasePath,
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
    if (!address || typeof address === 'string') throw new Error('ownership app server did not start');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const transfer = (target: { id: number; email: string }) => fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/ownership`,
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${session.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          targetUserId: target.id,
          confirmTargetEmail: target.email,
          password: PASSWORD,
        }),
      },
    );
    const responses = await Promise.all([transfer(firstTarget), transfer(secondTarget)]);
    const statuses = responses.map((response) => response.status).sort((left, right) => left - right);
    if (statuses[0] !== 200 || ![403, 409].includes(statuses[1] ?? 0)) {
      throw new Error(`PostgreSQL ownership concurrency returned ${statuses.join(',')}`);
    }
    const evidence = await database.query<{
      owners: number | string;
      events: number | string;
      former_owner_role: string;
    }>({
      text: `
        SELECT
          (SELECT COUNT(*) FROM workspace_memberships
            WHERE workspace_id = $1 AND role = 'owner' AND status = 'active') AS owners,
          (SELECT COUNT(*) FROM workspace_ownership_events
            WHERE workspace_id = $1) AS events,
          (SELECT role FROM workspace_memberships
            WHERE workspace_id = $1 AND user_id = $2) AS former_owner_role;
      `,
      values: [workspace.id, owner.id],
    });
    if (
      Number(evidence[0]?.owners) !== 1
      || Number(evidence[0]?.events) !== 1
      || evidence[0]?.former_owner_role !== 'admin'
    ) {
      throw new Error('PostgreSQL ownership evidence is inconsistent');
    }
    const localDatabase = createSqliteDatabase(localDatabasePath);
    const localEvents = localDatabase.query<{ count: number }>(
      'SELECT COUNT(*) AS count FROM workspace_ownership_events;',
    );
    if (Number(localEvents[0]?.count) !== 0) {
      throw new Error('Workspace ownership evidence leaked into local SQLite');
    }
    process.stdout.write('postgres Workspace ownership application composition smoke passed\n');
  } finally {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'postgres ownership smoke failed'}\n`);
  process.exitCode = 1;
});
