import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAsyncSqliteDatabase } from '../src/db/asyncDatabaseFactory';
import { type AsyncSqliteDatabase } from '../src/db/asyncSqlite';
import { AsyncUsageRatingRepository } from '../src/services/asyncUsageRatingRepository';
import { AsyncUserRepository } from '../src/services/asyncUserRepository';
import { AsyncWorkspaceRepository } from '../src/services/asyncWorkspaceRepository';
import { UsageRatingError } from '../src/services/usageRatingTypes';

const NOW = new Date('2026-08-15T12:00:00.000Z');

function createDatabase(): { database: AsyncSqliteDatabase; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'primalthrum-async-usage-rating-'));
  return {
    database: createAsyncSqliteDatabase(join(root, 'database.sqlite')),
    root,
  };
}

test('async usage rating preserves pricing, budgets, idempotency, and tenant scope', async () => {
  const { database, root } = createDatabase();
  const users = new AsyncUserRepository(database);
  const workspaces = new AsyncWorkspaceRepository(database);
  let ratedCount = 0;
  const ratings = new AsyncUsageRatingRepository(database, () => NOW, () => { ratedCount += 1; });
  try {
    const owner = await users.createUser('async-usage@example.com', 'hash', true);
    const workspace = await workspaces.create(owner.id, 'Usage Rating');
    const isolatedWorkspace = await workspaces.create(owner.id, 'Usage Isolated');
    await ratings.setControls({
      workspaceId: workspace.id,
      monthlyCreditLimit: 40,
      monthlyProviderCostMicrosLimit: 6000,
      hardLimit: true,
      alertThresholds: [100, 50, 80, 50],
      updatedByUserId: owner.id,
    });

    const first = await ratings.rate({
      workspaceId: workspace.id,
      idempotencyKey: 'run-1:input',
      meter: 'llm.input_tokens',
      provider: 'openai',
      model: 'gpt-test',
      quantity: 1500,
      resourceType: 'run',
      resourceId: '1',
      occurredAt: NOW.toISOString(),
    });
    const [replayed, second] = await Promise.all([
      ratings.rate({
        workspaceId: workspace.id,
        idempotencyKey: 'run-1:input',
        meter: 'llm.input_tokens',
        provider: 'openai',
        model: 'gpt-test',
        quantity: 1500,
        occurredAt: NOW.toISOString(),
      }),
      ratings.rate({
        workspaceId: workspace.id,
        idempotencyKey: 'run-2:input',
        meter: 'llm.input_tokens',
        quantity: 1500,
        resourceType: 'run',
        resourceId: '1',
        occurredAt: NOW.toISOString(),
      }),
    ]);
    assert.equal(replayed.id, first.id);
    assert.equal(second.creditsCharged, 20);
    assert.equal(first.createdAt.endsWith('Z'), true);
    assert.equal(ratedCount, 2);

    await assert.rejects(
      ratings.rate({
        workspaceId: workspace.id,
        idempotencyKey: 'run-3:input',
        meter: 'llm.input_tokens',
        quantity: 1,
        occurredAt: NOW.toISOString(),
      }),
      (error) => error instanceof UsageRatingError
        && error.code === 'MONTHLY_CREDIT_LIMIT_EXCEEDED',
    );
    await assert.rejects(
      ratings.rate({
        workspaceId: workspace.id,
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

    const summary = await ratings.summary(workspace.id, NOW);
    assert.equal(summary.creditsCharged, 40);
    assert.equal(summary.providerCostMicros, 6000);
    assert.equal(summary.eventCount, 2);
    assert.equal(summary.byMeter[0]?.quantity, 3000);
    assert.deepEqual((await ratings.listAlerts(workspace.id)).map((alert) => (
      `${alert.metric}:${alert.thresholdPercent}`
    )).sort(), [
      'credits:100', 'credits:50', 'credits:80',
      'provider_cost_micros:100', 'provider_cost_micros:50', 'provider_cost_micros:80',
    ]);
    assert.deepEqual(await ratings.summary(isolatedWorkspace.id, NOW), {
      workspaceId: isolatedWorkspace.id,
      periodStartsAt: '2026-08-01T00:00:00.000Z',
      periodEndsAt: '2026-09-01T00:00:00.000Z',
      creditsCharged: 0,
      providerCostMicros: 0,
      eventCount: 0,
      byMeter: [],
      controls: {
        workspaceId: isolatedWorkspace.id,
        monthlyCreditLimit: null,
        monthlyProviderCostMicrosLimit: null,
        hardLimit: true,
        overageEnabled: false,
        alertThresholds: [50, 80, 100],
      },
    });
    assert.deepEqual(
      await ratings.totalsForResource(workspace.id, 'run', '1'),
      { eventCount: 2, quantity: 3000, credits: 40, providerCostMicros: 6000 },
    );
    await assert.rejects(
      database.execute({
        text: 'DELETE FROM rated_usage_events WHERE id = $1;',
        values: [first.id],
      }),
      /immutable/,
    );
  } finally {
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('async usage rating selects a provider and model specific price', async () => {
  const { database, root } = createDatabase();
  const users = new AsyncUserRepository(database);
  const workspaces = new AsyncWorkspaceRepository(database);
  const ratings = new AsyncUsageRatingRepository(database, () => NOW);
  try {
    const owner = await users.createUser('async-price@example.com', 'hash', true);
    const workspace = await workspaces.create(owner.id, 'Provider Price');
    await ratings.configurePrice({
      pricingVersionKey: '2026-08-default',
      meter: 'llm.input_tokens',
      provider: 'openai',
      model: 'gpt-premium',
      unitSize: 1000,
      creditsPerUnit: 50,
      providerCostMicrosPerUnit: 12_000,
    });
    const rated = await ratings.rate({
      workspaceId: workspace.id,
      idempotencyKey: 'premium-1',
      meter: 'llm.input_tokens',
      provider: 'openai',
      model: 'gpt-premium',
      quantity: 1,
      occurredAt: NOW.toISOString(),
    });
    assert.equal(rated.creditsCharged, 50);
    assert.equal(rated.providerCostMicros, 12_000);
  } finally {
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
