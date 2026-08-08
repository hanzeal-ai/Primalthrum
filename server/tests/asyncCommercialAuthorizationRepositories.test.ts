import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAsyncSqliteDatabase } from '../src/db/asyncDatabaseFactory';
import { type AsyncSqliteDatabase } from '../src/db/asyncSqlite';
import { AsyncBillingPlanRepository } from '../src/services/asyncBillingPlanRepository';
import { AsyncEntitlementRepository } from '../src/services/asyncEntitlementRepository';
import { AsyncUserRepository } from '../src/services/asyncUserRepository';
import { AsyncWorkspaceRepository } from '../src/services/asyncWorkspaceRepository';
import { BillingError } from '../src/services/billingTypes';

function createDatabase(): { database: AsyncSqliteDatabase; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'primalthrum-async-commercial-auth-'));
  return {
    database: createAsyncSqliteDatabase(join(root, 'database.sqlite')),
    root,
  };
}

test('async plan catalog and entitlements preserve commercial authorization rules', async () => {
  const { database, root } = createDatabase();
  const users = new AsyncUserRepository(database);
  const workspaces = new AsyncWorkspaceRepository(database);
  const plans = new AsyncBillingPlanRepository(database);
  let now = new Date('2026-08-01T00:00:00.000Z');
  const entitlements = new AsyncEntitlementRepository(database, () => now);
  try {
    const owner = await users.createUser('async-commercial@example.com', 'hash', true);
    const workspace = await workspaces.create(owner.id, 'Commercial Auth');
    const isolated = await workspaces.create(owner.id, 'Commercial Isolated');
    const catalog = await plans.list();
    assert.deepEqual(catalog.map((plan) => plan.key), [
      'free', 'pro', 'team', 'business', 'enterprise',
    ]);
    assert.equal((await plans.find('pro'))?.monthlyPriceMinor, 2900);
    assert.equal((await plans.find('pro'))?.entitlements.find((item) => item.feature === 'voice')?.enabled, true);

    const free = await entitlements.snapshot(workspace.id);
    assert.equal(free.planKey, 'free');
    assert.equal(free.entitlements.voice?.enabled, false);
    assert.equal(free.entitlements['agents.create']?.quantityLimit, 2);
    await assert.rejects(
      entitlements.assert(workspace.id, 'voice'),
      (error) => error instanceof BillingError && error.code === 'ENTITLEMENT_REQUIRED',
    );
    await assert.rejects(
      entitlements.assert(workspace.id, 'agents.create', 2, 1),
      (error) => error instanceof BillingError
        && error.code === 'ENTITLEMENT_LIMIT_EXCEEDED',
    );

    await database.execute({
      text: `
        UPDATE workspace_subscriptions
        SET plan_key = 'pro', state = 'trialing', trial_ends_at = $2
        WHERE workspace_id = $1;
      `,
      values: [workspace.id, '2026-08-08T00:00:00.000Z'],
    });
    assert.equal((await entitlements.snapshot(workspace.id)).entitlements.voice?.enabled, true);
    const overridden = await entitlements.grant({
      workspaceId: workspace.id,
      feature: 'agents.create',
      enabled: true,
      quantityLimit: 50,
      sourceType: 'enterprise',
      sourceRef: 'contract-1',
      priority: 200,
    });
    assert.equal(overridden.entitlements['agents.create']?.quantityLimit, 50);
    assert.equal(overridden.entitlements['agents.create']?.source, 'enterprise:contract-1');

    now = new Date('2026-08-09T00:00:00.000Z');
    const expired = await entitlements.snapshot(workspace.id);
    assert.equal(expired.planKey, 'free');
    assert.equal(expired.subscriptionState, 'expired');
    assert.equal(expired.entitlements.voice?.enabled, false);
    assert.equal((await entitlements.snapshot(isolated.id)).planKey, 'free');
    const initialGrants = await database.query<{ count: number }>({
      text: `
        SELECT COUNT(*) AS count FROM credit_ledger_entries
        WHERE workspace_id = $1 AND source_type = 'plan';
      `,
      values: [workspace.id],
    });
    assert.equal(Number(initialGrants[0]?.count), 1);
  } finally {
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('async entitlement snapshot restricts expired payment grace', async () => {
  const { database, root } = createDatabase();
  const users = new AsyncUserRepository(database);
  const workspaces = new AsyncWorkspaceRepository(database);
  const entitlements = new AsyncEntitlementRepository(
    database,
    () => new Date('2026-08-10T00:00:00.000Z'),
  );
  try {
    const owner = await users.createUser('async-grace@example.com', 'hash', true);
    const workspace = await workspaces.create(owner.id, 'Expired Grace');
    await entitlements.snapshot(workspace.id);
    await database.execute({
      text: `
        UPDATE workspace_subscriptions
        SET plan_key = 'pro', state = 'past_due', grace_ends_at = $2
        WHERE workspace_id = $1;
      `,
      values: [workspace.id, '2026-08-09T00:00:00.000Z'],
    });
    const snapshot = await entitlements.snapshot(workspace.id);
    assert.equal(snapshot.subscriptionState, 'restricted');
    assert.equal(snapshot.planKey, 'free');
    assert.equal(snapshot.entitlements.voice?.enabled, false);
  } finally {
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
