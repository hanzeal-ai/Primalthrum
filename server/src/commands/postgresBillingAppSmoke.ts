import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../app';
import { PostgresDatabase } from '../db/postgres';
import { runPostgresMigrations } from '../db/postgresMigrations';
import { AsyncSessionRepository } from '../services/asyncSessionRepository';
import { AsyncUserRepository } from '../services/asyncUserRepository';
import { AsyncWorkspaceRepository } from '../services/asyncWorkspaceRepository';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const database = new PostgresDatabase({ connectionString, max: 6 });
  const root = mkdtempSync(join(tmpdir(), 'primalthrum-postgres-billing-app-'));
  let server: Server | undefined;
  try {
    await runPostgresMigrations(database);
    const marker = randomUUID();
    const users = new AsyncUserRepository(database);
    const workspaces = new AsyncWorkspaceRepository(database);
    const sessions = new AsyncSessionRepository(database);
    const owner = await users.createUser(`billing-app-${marker}@example.com`, 'hash', true);
    const workspace = await workspaces.create(owner.id, `Billing App ${marker}`);
    const principal = await workspaces.principalForUser(owner.id, workspace.id);
    if (!principal) throw new Error('PostgreSQL billing app principal was not created');
    const session = await sessions.create(principal);
    const app = createApp({
      dbPath: join(root, 'local.sqlite'),
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
    assert(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const headers = {
      authorization: `Bearer ${session.token}`,
      'content-type': 'application/json',
    };
    const trialResponse = await fetch(`${baseUrl}/api/billing/trial`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ planKey: 'pro' }),
    });
    if (trialResponse.status !== 201) {
      throw new Error(`PostgreSQL billing Trial API returned ${trialResponse.status}`);
    }
    const summaryResponse = await fetch(`${baseUrl}/api/billing/summary`, { headers });
    if (summaryResponse.status !== 200) {
      throw new Error(`PostgreSQL billing summary API returned ${summaryResponse.status}`);
    }
    const summary = await summaryResponse.json() as {
      entitlementSnapshot: { planKey: string; subscriptionState: string };
      creditAccount: { availableCredits: number };
      subscription: { planKey: string; state: string };
    };
    if (
      summary.entitlementSnapshot.planKey !== 'pro'
      || summary.entitlementSnapshot.subscriptionState !== 'trialing'
      || summary.creditAccount.availableCredits !== 10_000
      || summary.subscription.planKey !== 'pro'
      || summary.subscription.state !== 'trialing'
    ) {
      throw new Error('PostgreSQL billing app read from inconsistent persistence stores');
    }
    process.stdout.write('postgres billing application composition smoke passed\n');
  } finally {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'postgres billing app smoke failed'}\n`);
  process.exitCode = 1;
});
