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
import { totpAt } from '../services/totp';

const PASSWORD = 'correct horse battery staple';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const database = new PostgresDatabase({ connectionString, max: 8 });
  const root = mkdtempSync(join(tmpdir(), 'primalthrum-postgres-mfa-app-'));
  const localDatabasePath = join(root, 'local.sqlite');
  let server: Server | undefined;
  try {
    await runPostgresMigrations(database);
    const marker = randomUUID();
    const email = `mfa-app-${marker}@example.com`;
    const users = new AsyncUserRepository(database);
    const workspaces = new AsyncWorkspaceRepository(database);
    const sessions = new AsyncSessionRepository(database);
    const owner = await users.createUser(email, hashPassword(PASSWORD), true);
    const workspace = await workspaces.create(owner.id, `MFA App ${marker}`);
    const principal = await workspaces.principalForUser(owner.id, workspace.id);
    if (!principal) throw new Error('PostgreSQL MFA principal was not created');
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
    if (!address || typeof address === 'string') throw new Error('MFA app server did not start');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const setup = await fetch(`${baseUrl}/api/settings/mfa/setup`, {
      method: 'POST', headers: jsonHeaders(session.token),
      body: JSON.stringify({ password: PASSWORD }),
    });
    if (setup.status !== 201) throw new Error(`PostgreSQL MFA setup returned ${setup.status}`);
    const setupBody = await setup.json() as { secret: string };
    const storedSecrets = await database.query<{ ciphertext: string }>({
      text: `
        SELECT secret.ciphertext FROM user_mfa_factors factor
        JOIN secrets secret ON secret.secret_ref = factor.secret_ref
        WHERE factor.user_id = $1;
      `,
      values: [owner.id],
    });
    if (!storedSecrets[0] || storedSecrets[0].ciphertext.includes(setupBody.secret)) {
      throw new Error('PostgreSQL MFA secret was not encrypted');
    }
    const confirm = await fetch(`${baseUrl}/api/settings/mfa/confirm`, {
      method: 'POST', headers: jsonHeaders(session.token),
      body: JSON.stringify({ code: totpAt(setupBody.secret) }),
    });
    if (confirm.status !== 200) throw new Error(`PostgreSQL MFA confirm returned ${confirm.status}`);
    const confirmed = await confirm.json() as {
      enabled: boolean;
      recoveryCodes: string[];
      recoveryCodesRemaining: number;
    };
    if (!confirmed.enabled || confirmed.recoveryCodesRemaining !== 10) {
      throw new Error('PostgreSQL MFA confirmation state is inconsistent');
    }
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST', headers: jsonHeaders(),
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    if (login.status !== 202) throw new Error(`PostgreSQL MFA login returned ${login.status}`);
    const challenge = await login.json() as { challengeToken: string };
    const verified = await fetch(`${baseUrl}/api/auth/mfa/verify`, {
      method: 'POST', headers: jsonHeaders(),
      body: JSON.stringify({
        challengeToken: challenge.challengeToken,
        code: totpAt(setupBody.secret, Date.now() + 30_000),
      }),
    });
    if (verified.status !== 200) throw new Error(`PostgreSQL MFA challenge returned ${verified.status}`);
    const replay = await fetch(`${baseUrl}/api/auth/mfa/verify`, {
      method: 'POST', headers: jsonHeaders(),
      body: JSON.stringify({
        challengeToken: challenge.challengeToken,
        code: confirmed.recoveryCodes[0],
      }),
    });
    if (replay.status !== 401) throw new Error('PostgreSQL MFA challenge replay was accepted');
    const evidence = await database.query<{ factors: number | string; events: number | string }>({
      text: `
        SELECT
          (SELECT COUNT(*) FROM user_mfa_factors WHERE user_id = $1) AS factors,
          (SELECT COUNT(*) FROM user_mfa_events WHERE user_id = $1) AS events;
      `,
      values: [owner.id],
    });
    if (Number(evidence[0]?.factors) !== 1 || Number(evidence[0]?.events) < 2) {
      throw new Error('PostgreSQL MFA evidence is inconsistent');
    }
    const localDatabase = createSqliteDatabase(localDatabasePath);
    const local = localDatabase.query<{ factors: number; events: number; secrets: number }>(`
      SELECT
        (SELECT COUNT(*) FROM user_mfa_factors) AS factors,
        (SELECT COUNT(*) FROM user_mfa_events) AS events,
        (SELECT COUNT(*) FROM secrets) AS secrets;
    `)[0];
    if (local?.factors || local?.events || local?.secrets) {
      throw new Error('MFA lifecycle leaked into the local SQLite database');
    }
    process.stdout.write('postgres MFA application composition smoke passed\n');
  } finally {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function jsonHeaders(token = ''): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'postgres MFA app smoke failed'}\n`);
  process.exitCode = 1;
});
