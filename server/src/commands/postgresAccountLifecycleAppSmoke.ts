import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../app';
import { createSqliteDatabase } from '../db/databaseFactory';
import { PostgresDatabase } from '../db/postgres';
import { runPostgresMigrations } from '../db/postgresMigrations';
import { AsyncAccountEmailOutboxRepository } from '../services/asyncAccountEmailOutboxRepository';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const database = new PostgresDatabase({ connectionString, max: 8 });
  const root = mkdtempSync(join(tmpdir(), 'primalthrum-postgres-account-app-'));
  const localDatabasePath = join(root, 'local.sqlite');
  let server: Server | undefined;
  try {
    await runPostgresMigrations(database);
    await database.execute({
      text: `
        UPDATE account_email_outbox
        SET status = 'superseded', payload_json = '{}', updated_at = CURRENT_TIMESTAMP
        WHERE status IN ('pending', 'delivering', 'failed');
      `,
    });
    const marker = randomUUID();
    const app = createApp({
      dbPath: localDatabasePath,
      documentStorageDir: join(root, 'documents'),
      generatedAgentsDir: join(root, 'generated-agents'),
      identityDatabase: database,
      runtimeDatabase: database,
      exposeAccountEmailPreview: true,
      logger: { log: () => undefined },
      startBackgroundSchedulers: false,
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server?.once('listening', resolve));
    const address = server.address();
    assert(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const registration = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: `account-app-${marker}@example.com`,
        password: 'correct horse battery staple',
        workspaceName: `Account App ${marker}`,
        planKey: 'pro',
      }),
    });
    if (registration.status !== 201) {
      throw new Error(`PostgreSQL account registration returned ${registration.status}`);
    }
    const registered = await registration.json() as {
      user: { id: number; workspaceId: number };
      emailPreviewUrl: string;
    };
    const token = new URL(registered.emailPreviewUrl).searchParams.get('token');
    if (!token) throw new Error('PostgreSQL registration did not expose a verification token');
    const verification = await fetch(`${baseUrl}/api/auth/verify-email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (verification.status !== 200) {
      throw new Error(`PostgreSQL email verification returned ${verification.status}`);
    }
    const verified = await verification.json() as {
      onboarding: { state: string };
      trial: { planKey: string };
      entitlementSnapshot: { subscriptionState: string };
      creditAccount: { availableCredits: number };
    };
    if (
      verified.onboarding.state !== 'pending_email'
      || verified.trial.planKey !== 'pro'
      || verified.entitlementSnapshot.subscriptionState !== 'trialing'
      || verified.creditAccount.availableCredits !== 10_000
    ) {
      throw new Error('PostgreSQL account lifecycle response is inconsistent');
    }
    const rows = await database.query<{
      email_verified_at: Date | null;
      state: string;
      used_tokens: number | string;
      queued_emails: number | string;
    }>({
      text: `
        SELECT u.email_verified_at, onboarding.state,
          (SELECT COUNT(*) FROM account_action_tokens
            WHERE user_id = u.id AND used_at IS NOT NULL) AS used_tokens,
          (SELECT COUNT(*) FROM account_email_outbox
            WHERE user_id = u.id) AS queued_emails
        FROM users u
        JOIN workspace_onboarding onboarding ON onboarding.owner_user_id = u.id
        WHERE u.id = $1 AND onboarding.workspace_id = $2;
      `,
      values: [registered.user.id, registered.user.workspaceId],
    });
    if (
      !rows[0]?.email_verified_at
      || rows[0].state !== 'active'
      || Number(rows[0].used_tokens) !== 1
      || Number(rows[0].queued_emails) !== 1
    ) {
      throw new Error('PostgreSQL account lifecycle evidence is inconsistent');
    }
    const outbox = new AsyncAccountEmailOutboxRepository(database);
    const claims = await Promise.all([outbox.claimNext(), outbox.claimNext()]);
    const claimed = claims.find((claim) => claim !== null);
    if (!claimed || claims.filter((claim) => claim !== null).length !== 1) {
      throw new Error('PostgreSQL account email was not claimed exactly once');
    }
    await outbox.markDelivered(claimed.id, {
      provider: 'test',
      providerMessageId: `account-app-${marker}`,
    });
    const providerEvent = {
      provider: 'test',
      providerEventId: `delivered:account-app-${marker}`,
      providerMessageId: `account-app-${marker}`,
      eventType: 'delivered' as const,
      occurredAt: new Date().toISOString(),
    };
    if ((await outbox.recordProviderEvent(providerEvent)).duplicate) {
      throw new Error('new PostgreSQL Provider event was treated as a duplicate');
    }
    if (!(await outbox.recordProviderEvent(providerEvent)).duplicate) {
      throw new Error('PostgreSQL Provider event replay was not idempotent');
    }
    await outbox.enqueue({
      template: 'reset_password',
      recipientEmail: `account-app-${marker}@example.com`,
      payload: {
        userId: registered.user.id,
        actionUrl: 'https://app.example.com/reset-password?token=redacted',
      },
    });
    const resetEmail = await outbox.claimNext();
    if (!resetEmail) throw new Error('PostgreSQL reset email could not be claimed');
    await outbox.markFailed(resetEmail.id, resetEmail.attempts, 'invalid recipient', {
      retryable: false,
    });
    const emailSummary = await outbox.summary();
    if (emailSummary.delivered !== 1 || emailSummary.deadLettered !== 1) {
      throw new Error('PostgreSQL account email delivery state is inconsistent');
    }
    const localDatabase = createSqliteDatabase(localDatabasePath);
    const localCounts = localDatabase.query<{
      tokens: number;
      onboarding: number;
      emails: number;
    }>(`
      SELECT
        (SELECT COUNT(*) FROM account_action_tokens) AS tokens,
        (SELECT COUNT(*) FROM workspace_onboarding) AS onboarding,
        (SELECT COUNT(*) FROM account_email_outbox) AS emails;
    `)[0];
    if (localCounts?.tokens || localCounts?.onboarding || localCounts?.emails) {
      throw new Error('account lifecycle leaked into the local SQLite database');
    }
    process.stdout.write('postgres account lifecycle application composition smoke passed\n');
  } finally {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'postgres account app smoke failed'}\n`);
  process.exitCode = 1;
});
