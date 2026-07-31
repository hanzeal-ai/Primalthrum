import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { SqliteDatabase } from '../src/db/sqlite';
import { BillingRepository } from '../src/services/billingRepository';
import { RunUsageService } from '../src/services/runUsageService';
import { UsageRatingRepository } from '../src/services/usageRatingRepository';
import { UsageRatingError } from '../src/services/usageRatingTypes';

const NOW = new Date('2026-08-15T12:00:00.000Z');

let rootDir = '';
let db: SqliteDatabase;
let billing: BillingRepository;
let ratings: UsageRatingRepository;
let usage: RunUsageService;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'primalthrum-run-usage-'));
  db = new SqliteDatabase(join(rootDir, 'platform.sqlite'));
  billing = new BillingRepository(db, () => NOW);
  ratings = new UsageRatingRepository(db, () => NOW);
  usage = new RunUsageService(ratings, billing, () => NOW);
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

test('run usage reserves an estimate and settles the sum of rated evidence', () => {
  const reservation = usage.reserve({
    runId: 7,
    workspaceId: 1,
    prompt: 'Build a support agent',
    llm: { provider: 'openai', model: 'gpt-test', max_tokens: 1024 },
    channel: 'api',
  });
  assert.equal(reservation.state, 'reserved');
  assert.equal(reservation.reservedCredits, 80);

  usage.recordRun({ runId: 7, workspaceId: 1, channel: 'api' });
  usage.recordRun({ runId: 7, workspaceId: 1, channel: 'api' });
  usage.recordLlmUsage({
    runId: 7,
    workspaceId: 1,
    provider: 'openai',
    model: 'gpt-test',
    inputTokens: 200,
    outputTokens: 500,
  });
  usage.recordToolCall({
    runId: 7,
    workspaceId: 1,
    eventId: 99,
    tool: 'file_reader',
  });
  const settlement = usage.settle(7, 1);
  assert.equal('creditsCharged' in settlement ? settlement.creditsCharged : -1, 55);
  assert.deepEqual(billing.creditAccount(1), {
    workspaceId: 1,
    availableCredits: 945,
    reservedCredits: 0,
    spentCredits: 55,
    updatedAt: billing.creditAccount(1).updatedAt,
  });
  assert.deepEqual(ratings.totalsForResource(1, 'run', '7'), {
    eventCount: 4,
    quantity: 702,
    credits: 55,
    providerCostMicros: 7500,
  });
  assert.equal(usage.settle(7, 1).id, settlement.id);
});

test('failed run without consumed resources releases the full reservation', () => {
  usage.reserve({
    runId: 8,
    workspaceId: 1,
    prompt: 'Fail before provider execution',
    llm: { provider: 'mock', model: 'mock-chat' },
    channel: 'hosted',
  });
  const released = usage.settle(8, 1);
  assert.equal('state' in released ? released.state : '', 'released');
  assert.equal(billing.creditAccount(1).availableCredits, 1000);
  assert.equal(billing.creditAccount(1).reservedCredits, 0);
});

test('projected provider cost is rejected before a reservation is created', () => {
  ratings.setControls({
    workspaceId: 1,
    monthlyProviderCostMicrosLimit: 1000,
    hardLimit: true,
  });
  assert.throws(
    () => usage.reserve({
      runId: 9,
      workspaceId: 1,
      prompt: 'Expensive run',
      llm: { provider: 'openai', model: 'gpt-test', max_tokens: 1024 },
      channel: 'api',
    }),
    (error) => error instanceof UsageRatingError
      && error.code === 'MONTHLY_COST_LIMIT_EXCEEDED',
  );
  assert.equal(
    db.query<{ count: number }>(`SELECT COUNT(*) AS count FROM credit_reservations;`)[0]?.count,
    0,
  );
});
