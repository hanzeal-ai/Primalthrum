import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../app';
import { createSqliteDatabase } from '../db/databaseFactory';
import { PostgresDatabase } from '../db/postgres';
import { runPostgresMigrations } from '../db/postgresMigrations';
import { AsyncPrivacyAnalyticsRepository } from '../services/asyncPrivacyAnalyticsRepository';
import { PRIVACY_POLICY_VERSION } from '../services/privacyAnalyticsStore';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const database = new PostgresDatabase({ connectionString, max: 8 });
  const root = mkdtempSync(join(tmpdir(), 'primalthrum-postgres-privacy-app-'));
  const localDatabasePath = join(root, 'local.sqlite');
  let server: Server | undefined;
  try {
    await runPostgresMigrations(database);
    await verifyConcurrentRepositoryIdempotency(database);

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
    if (!address || typeof address === 'string') throw new Error('privacy app server did not start');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const subjectId = randomUUID();
    const granted = await consent(baseUrl, subjectId, true);
    if (granted.action !== 'granted') throw new Error('PostgreSQL privacy grant was not recorded');

    const eventId = randomUUID();
    const occurredAt = new Date().toISOString();
    const accepted = await event(baseUrl, subjectId, granted.receiptId, eventId, occurredAt);
    if (accepted.status !== 202) {
      throw new Error(`PostgreSQL analytics event returned ${accepted.status}`);
    }
    const replay = await event(baseUrl, subjectId, granted.receiptId, eventId, occurredAt);
    const replayBody = await replay.json() as { duplicate?: boolean };
    if (replay.status !== 202 || replayBody.duplicate !== true) {
      throw new Error('PostgreSQL analytics event replay was not idempotent');
    }

    const withdrawn = await consent(baseUrl, subjectId, false);
    if (withdrawn.action !== 'withdrawn') {
      throw new Error('PostgreSQL privacy withdrawal was not recorded');
    }
    const blocked = await event(baseUrl, subjectId, granted.receiptId, randomUUID());
    if (blocked.status !== 403) throw new Error('PostgreSQL accepted analytics after withdrawal');

    const evidence = await database.query<{
      receipts: number | string;
      events: number | string;
    }>({
      text: `
        SELECT
          (SELECT COUNT(*) FROM privacy_consent_receipts WHERE receipt_id IN ($1, $2)) AS receipts,
          (SELECT COUNT(*) FROM product_analytics_events WHERE event_id = $3) AS events;
      `,
      values: [granted.receiptId, withdrawn.receiptId, eventId],
    });
    if (Number(evidence[0]?.receipts) !== 2 || Number(evidence[0]?.events) !== 1) {
      throw new Error('PostgreSQL privacy evidence is inconsistent');
    }

    const localDatabase = createSqliteDatabase(localDatabasePath);
    const local = localDatabase.query<{ receipts: number; events: number }>(`
      SELECT
        (SELECT COUNT(*) FROM privacy_consent_receipts) AS receipts,
        (SELECT COUNT(*) FROM product_analytics_events) AS events;
    `)[0];
    if (local?.receipts || local?.events) {
      throw new Error('privacy or analytics evidence leaked into local SQLite');
    }
    process.stdout.write('postgres privacy analytics application composition smoke passed\n');
  } finally {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
}

async function verifyConcurrentRepositoryIdempotency(database: PostgresDatabase): Promise<void> {
  const first = new AsyncPrivacyAnalyticsRepository(database);
  const second = new AsyncPrivacyAnalyticsRepository(database);
  const subjectId = randomUUID();
  const receipt = await first.recordConsent({ subjectId, analytics: true, source: 'banner' });
  const eventInput = {
    subjectId,
    consentReceiptId: receipt.receiptId,
    eventId: randomUUID(),
    eventName: 'page_view' as const,
    path: '/',
    properties: { source: 'postgres_smoke', authenticated: false },
    occurredAt: new Date().toISOString(),
  };
  const results = await Promise.all([first.recordEvent(eventInput), second.recordEvent(eventInput)]);
  const duplicates = results.map((result) => result?.duplicate).sort();
  if (duplicates[0] !== false || duplicates[1] !== true) {
    throw new Error('PostgreSQL analytics idempotency was not shared across repository instances');
  }
}

async function consent(baseUrl: string, subjectId: string, analytics: boolean): Promise<{
  receiptId: string;
  action: 'granted' | 'denied' | 'withdrawn';
}> {
  const response = await fetch(`${baseUrl}/api/public/privacy/consents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      subjectId,
      analytics,
      source: 'preferences',
      policyVersion: PRIVACY_POLICY_VERSION,
    }),
  });
  if (response.status !== 201) throw new Error(`PostgreSQL privacy consent returned ${response.status}`);
  return response.json() as Promise<{
    receiptId: string;
    action: 'granted' | 'denied' | 'withdrawn';
  }>;
}

function event(
  baseUrl: string,
  subjectId: string,
  receiptId: string,
  eventId: string,
  occurredAt = new Date().toISOString(),
) {
  return fetch(`${baseUrl}/api/public/analytics/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      subjectId,
      consentReceiptId: receiptId,
      eventId,
      eventName: 'page_view',
      path: '/',
      properties: { source: 'postgres_smoke', authenticated: false },
      occurredAt,
    }),
  });
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'postgres privacy smoke failed'}\n`);
  process.exitCode = 1;
});
