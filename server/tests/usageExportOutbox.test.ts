import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { SqliteDatabase } from '../src/db/sqlite';
import { createSqliteDatabase } from '../src/db/databaseFactory';
import { type StructuredLogger } from '../src/services/logger';
import { UsageExportDispatcher } from '../src/services/usageExportDispatcher';
import { UsageExportOutboxRepository } from '../src/services/usageExportOutboxRepository';
import {
  HttpUsageMeterExporter,
  type UsageMeterExporter,
  type UsageMeterExportPayload,
} from '../src/services/usageMeterExporter';
import { UsageRatingRepository } from '../src/services/usageRatingRepository';

const NOW = new Date(Date.now() + 60_000);
const silentLogger: StructuredLogger = { log: () => undefined };

let rootDir = '';
let db: SqliteDatabase;
let outbox: UsageExportOutboxRepository;
let ratings: UsageRatingRepository;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'primalthrum-usage-export-'));
  db = createSqliteDatabase(join(rootDir, 'platform.sqlite'));
  outbox = new UsageExportOutboxRepository(db, () => NOW);
  ratings = new UsageRatingRepository(db, () => NOW);
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

test('rated usage is durably enqueued once for idempotent replay', () => {
  const input = {
    workspaceId: 1,
    idempotencyKey: 'run-1:input',
    meter: 'llm.input_tokens',
    quantity: 100,
    occurredAt: NOW.toISOString(),
  };
  ratings.rate(input);
  ratings.rate(input);

  const rows = db.query<{ status: string; attempts: number }>(`
    SELECT status, attempts FROM usage_meter_exports;
  `);
  assert.deepEqual(rows, [{ status: 'pending', attempts: 0 }]);
});

test('dispatcher delivers each event once and records completion', async () => {
  ratings.rate({
    workspaceId: 1,
    idempotencyKey: 'run-2:output',
    meter: 'llm.output_tokens',
    quantity: 25,
    occurredAt: NOW.toISOString(),
  });
  const delivered: UsageMeterExportPayload[] = [];
  const exporter: UsageMeterExporter = {
    destination: 'primary',
    send: async (payload) => { delivered.push(payload); },
  };
  const dispatcher = new UsageExportDispatcher(outbox, exporter, silentLogger);

  await dispatcher.drain();
  await dispatcher.drain();

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]?.idempotencyKey, 'run-2:output');
  assert.equal(delivered[0]?.creditsCharged, 30);
  assert.deepEqual(db.query<{ status: string; attempts: number }>(`
    SELECT status, attempts FROM usage_meter_exports;
  `), [{ status: 'delivered', attempts: 1 }]);
});

test('dispatcher retains failures with exponential retry evidence', async () => {
  ratings.rate({
    workspaceId: 1,
    idempotencyKey: 'run-3:input',
    meter: 'llm.input_tokens',
    quantity: 1,
    occurredAt: NOW.toISOString(),
  });
  const dispatcher = new UsageExportDispatcher(outbox, {
    destination: 'primary',
    send: async () => { throw new Error('sink unavailable'); },
  }, silentLogger);

  await dispatcher.drain();

  const row = db.query<{
    status: string;
    attempts: number;
    last_error: string;
    next_attempt_at: string;
  }>(`SELECT status, attempts, last_error, next_attempt_at FROM usage_meter_exports;`)[0];
  assert.equal(row?.status, 'failed');
  assert.equal(row?.attempts, 1);
  assert.equal(row?.last_error, 'sink unavailable');
  assert.equal(row?.next_attempt_at, new Date(NOW.getTime() + 1_000).toISOString());
  assert.ok((outbox.nextAttemptDelayMs('primary') ?? 0) >= 999);
});

test('HTTP exporter sends stable idempotency and authorization headers', async () => {
  let request: { input: string | URL | Request; init?: RequestInit } | undefined;
  const exporter = new HttpUsageMeterExporter(
    'https://meter.example.com/events',
    'secret-token',
    async (input, init) => {
      request = { input, init };
      return new Response(null, { status: 202 });
    },
  );
  const payload: UsageMeterExportPayload = {
    eventId: 42,
    workspaceId: 1,
    idempotencyKey: 'run-42:output',
    meter: 'llm.output_tokens',
    provider: 'openai',
    model: 'gpt-test',
    quantity: 10,
    billableUnits: 1,
    creditsCharged: 20,
    providerCostMicros: 6000,
    resourceType: 'run',
    resourceId: '42',
    metadata: {},
    occurredAt: NOW.toISOString(),
    createdAt: NOW.toISOString(),
  };

  await exporter.send(payload);

  assert.equal(String(request?.input), 'https://meter.example.com/events');
  assert.equal(request?.init?.method, 'POST');
  assert.equal((request?.init?.headers as Record<string, string>)['Idempotency-Key'], 'primalthrum-usage-42');
  assert.equal((request?.init?.headers as Record<string, string>).Authorization, 'Bearer secret-token');
  assert.deepEqual(JSON.parse(String(request?.init?.body)), payload);
});

test('HTTP exporter rejects non-success responses for durable retry', async () => {
  const exporter = new HttpUsageMeterExporter(
    'https://meter.example.com/events',
    '',
    async () => new Response(null, { status: 503 }),
  );
  await assert.rejects(() => exporter.send({
    eventId: 1,
    workspaceId: 1,
    idempotencyKey: 'usage-1',
    meter: 'api.runs',
    provider: '',
    model: '',
    quantity: 1,
    billableUnits: 1,
    creditsCharged: 1,
    providerCostMicros: 0,
    resourceType: 'run',
    resourceId: '1',
    metadata: {},
    occurredAt: NOW.toISOString(),
    createdAt: NOW.toISOString(),
  }), /status 503/);
});
