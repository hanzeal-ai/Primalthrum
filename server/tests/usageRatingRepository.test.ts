import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { SqliteDatabase } from '../src/db/sqlite';
import { createSqliteDatabase } from '../src/db/databaseFactory';
import { UsageRatingRepository } from '../src/services/usageRatingRepository';
import { UsageRatingError } from '../src/services/usageRatingTypes';

const NOW = new Date('2026-08-15T12:00:00.000Z');

let rootDir = '';
let db: SqliteDatabase;
let ratings: UsageRatingRepository;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'primalthrum-usage-rating-'));
  db = createSqliteDatabase(join(rootDir, 'platform.sqlite'));
  ratings = new UsageRatingRepository(db, () => NOW);
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

test('rating uses versioned prices and preserves immutable idempotent evidence', () => {
  const usage = ratings.rate({
    workspaceId: 1,
    idempotencyKey: 'run-1:input',
    meter: 'llm.input_tokens',
    provider: 'openai',
    model: 'gpt-test',
    quantity: 1500,
    resourceType: 'run',
    resourceId: '1',
    occurredAt: NOW.toISOString(),
  });
  assert.equal(usage.billableUnits, 2);
  assert.equal(usage.creditsCharged, 20);
  assert.equal(usage.providerCostMicros, 3000);
  assert.equal(
    ratings.rate({
      workspaceId: 1,
      idempotencyKey: 'run-1:input',
      meter: 'llm.input_tokens',
      provider: 'openai',
      model: 'gpt-test',
      quantity: 1500,
      occurredAt: NOW.toISOString(),
    }).id,
    usage.id,
  );
  assert.throws(
    () => ratings.rate({
      workspaceId: 1,
      idempotencyKey: 'run-1:input',
      meter: 'llm.input_tokens',
      provider: 'openai',
      model: 'gpt-test',
      quantity: 1501,
      occurredAt: NOW.toISOString(),
    }),
    (error) => error instanceof UsageRatingError
      && error.code === 'USAGE_IDEMPOTENCY_CONFLICT',
  );
  assert.throws(
    () => db.run('UPDATE rated_usage_events SET quantity = 0 WHERE id = 1;'),
    /immutable/,
  );
});

test('provider and model prices override wildcard pricing', () => {
  ratings.configurePrice({
    pricingVersionKey: '2026-08-default',
    meter: 'llm.input_tokens',
    provider: 'openai',
    model: 'gpt-premium',
    unitSize: 1000,
    creditsPerUnit: 50,
    providerCostMicrosPerUnit: 12_000,
  });
  const usage = ratings.rate({
    workspaceId: 1,
    idempotencyKey: 'premium-1',
    meter: 'llm.input_tokens',
    provider: 'openai',
    model: 'gpt-premium',
    quantity: 1,
    occurredAt: NOW.toISOString(),
  });
  assert.equal(usage.creditsCharged, 50);
  assert.equal(usage.providerCostMicros, 12_000);
});

test('hard budgets reject projected overage and create threshold alerts once', () => {
  ratings.setControls({
    workspaceId: 1,
    monthlyCreditLimit: 40,
    monthlyProviderCostMicrosLimit: 6000,
    hardLimit: true,
    alertThresholds: [50, 80, 100],
  });
  ratings.rate({
    workspaceId: 1,
    idempotencyKey: 'budget-1',
    meter: 'llm.input_tokens',
    quantity: 1500,
    occurredAt: NOW.toISOString(),
  });
  ratings.rate({
    workspaceId: 1,
    idempotencyKey: 'budget-2',
    meter: 'llm.input_tokens',
    quantity: 1500,
    occurredAt: NOW.toISOString(),
  });
  assert.throws(
    () => ratings.rate({
      workspaceId: 1,
      idempotencyKey: 'budget-3',
      meter: 'llm.input_tokens',
      quantity: 1,
      occurredAt: NOW.toISOString(),
    }),
    (error) => error instanceof UsageRatingError
      && error.code === 'MONTHLY_CREDIT_LIMIT_EXCEEDED',
  );
  const summary = ratings.summary(1, NOW);
  assert.equal(summary.creditsCharged, 40);
  assert.equal(summary.providerCostMicros, 6000);
  assert.equal(summary.eventCount, 2);
  assert.equal(summary.byMeter[0]?.quantity, 3000);
  const alerts = db.query<{ threshold_percent: number; metric: string }>(`
    SELECT threshold_percent, metric FROM cost_alerts
    ORDER BY metric, threshold_percent;
  `);
  assert.deepEqual(alerts, [
    { threshold_percent: 50, metric: 'credits' },
    { threshold_percent: 80, metric: 'credits' },
    { threshold_percent: 100, metric: 'credits' },
    { threshold_percent: 50, metric: 'provider_cost_micros' },
    { threshold_percent: 80, metric: 'provider_cost_micros' },
    { threshold_percent: 100, metric: 'provider_cost_micros' },
  ]);
});

test('cost cap can reject usage before the credit cap is reached', () => {
  ratings.setControls({
    workspaceId: 1,
    monthlyCreditLimit: 1000,
    monthlyProviderCostMicrosLimit: 1000,
    hardLimit: true,
  });
  assert.throws(
    () => ratings.rate({
      workspaceId: 1,
      idempotencyKey: 'cost-limit-1',
      meter: 'llm.output_tokens',
      quantity: 1,
      occurredAt: NOW.toISOString(),
    }),
    (error) => error instanceof UsageRatingError
      && error.code === 'MONTHLY_COST_LIMIT_EXCEEDED',
  );
  assert.equal(ratings.summary(1, NOW).eventCount, 0);
});
