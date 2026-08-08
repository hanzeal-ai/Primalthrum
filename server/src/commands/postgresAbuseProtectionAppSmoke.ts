import { mkdtempSync, rmSync } from 'node:fs';
import { type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../app';
import { createSqliteDatabase } from '../db/databaseFactory';
import { PostgresDatabase } from '../db/postgres';
import { runPostgresMigrations } from '../db/postgresMigrations';
import { AsyncAbuseProtectionRepository } from '../services/asyncAbuseProtectionRepository';

const HASH_SECRET = 'postgres-abuse-protection-hash-secret-32-bytes';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const database = new PostgresDatabase({ connectionString, max: 12 });
  const root = mkdtempSync(join(tmpdir(), 'primalthrum-postgres-abuse-app-'));
  const localDatabasePath = join(root, 'local.sqlite');
  let server: Server | undefined;
  try {
    await runPostgresMigrations(database);
    const now = () => new Date('2026-08-15T12:00:00.000Z');
    const first = new AsyncAbuseProtectionRepository(database, HASH_SECRET, now);
    const second = new AsyncAbuseProtectionRepository(database, HASH_SECRET, now);
    const decisions = await Promise.all(Array.from({ length: 20 }, (_, index) => (
      (index % 2 ? first : second).consume({
        ruleKey: 'postgres_smoke.ip',
        subject: 'ip:198.51.100.8',
        limit: 10,
        windowMs: 60_000,
      })
    )));
    if (decisions.filter((decision) => decision.allowed).length !== 10) {
      throw new Error('PostgreSQL rate limit was not atomic across repository instances');
    }
    const counts = decisions.map((decision) => decision.count).sort((left, right) => left - right);
    if (counts.some((count, index) => count !== index + 1)) {
      throw new Error('PostgreSQL rate limit counts are inconsistent');
    }
    const grant = {
      ruleKey: 'postgres_smoke',
      subject: 'ip:198.51.100.8',
      idempotencyKey: 'postgres-smoke-run',
    };
    await first.grantChallenge(grant);
    if (!await second.hasChallengeGrant(grant)) {
      throw new Error('PostgreSQL challenge grant was not shared across instances');
    }
    await first.recordEnforcement({
      ruleKey: 'postgres_smoke', action: 'smoke', subjectHash: first.hash(grant.subject),
      outcome: 'rate_limited', retryAfterSeconds: 60,
    });
    const app = createApp({
      dbPath: localDatabasePath,
      documentStorageDir: join(root, 'documents'),
      generatedAgentsDir: join(root, 'generated-agents'),
      identityDatabase: database,
      runtimeDatabase: database,
      abuseHashSecret: HASH_SECRET,
      logger: { log: () => undefined },
      startBackgroundSchedulers: false,
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server?.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('abuse app server did not start');
    const url = `http://127.0.0.1:${address.port}/api/setup/admin`;
    const request = () => fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'blocked@example.com', password: 'irrelevant password' }),
    });
    const statuses: number[] = [];
    for (let index = 0; index < 4; index += 1) statuses.push((await request()).status);
    if (statuses[3] !== 429) {
      throw new Error(`PostgreSQL application rate limit returned ${statuses.join(',')}`);
    }
    const applicationBucket = await database.query<{ request_count: number }>({
      text: `
        SELECT request_count FROM abuse_rate_limit_buckets
        WHERE rule_key = 'setup_admin.ip' ORDER BY updated_at DESC LIMIT 1;
      `,
    });
    if (Number(applicationBucket[0]?.request_count) !== 4) {
      throw new Error('PostgreSQL application did not compose the shared abuse store');
    }
    const localDatabase = createSqliteDatabase(localDatabasePath);
    const local = localDatabase.query<{ buckets: number; events: number }>(`
      SELECT
        (SELECT COUNT(*) FROM abuse_rate_limit_buckets) AS buckets,
        (SELECT COUNT(*) FROM abuse_enforcement_events) AS events;
    `)[0];
    if (local?.buckets || local?.events) {
      throw new Error('abuse protection evidence leaked into local SQLite');
    }
    process.stdout.write('postgres abuse protection application composition smoke passed\n');
  } finally {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'postgres abuse smoke failed'}\n`);
  process.exitCode = 1;
});
