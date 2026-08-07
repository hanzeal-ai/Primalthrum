import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { SqliteDatabase } from '../src/db/sqlite';
import { createSqliteDatabase } from '../src/db/databaseFactory';
import { BillingError, BillingRepository } from '../src/services/billingRepository';

const FIXED_NOW = new Date('2026-08-01T00:00:00.000Z');

let rootDir = '';
let db: SqliteDatabase;
let billing: BillingRepository;
let currentNow = FIXED_NOW;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'primalthrum-billing-'));
  currentNow = FIXED_NOW;
  db = createSqliteDatabase(join(rootDir, 'platform.sqlite'));
  billing = new BillingRepository(db, () => currentNow);
  db.run(`
    INSERT INTO users (id, workspace_id, email, password_hash, role)
    VALUES (1, 1, 'billing@example.com', 'hash', 'admin');
  `);
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

test('plan catalog and trial grants compose into an entitlement snapshot', () => {
  const plans = billing.listPlans();
  assert.deepEqual(plans.map((plan) => plan.key), [
    'free',
    'pro',
    'team',
    'business',
    'enterprise',
  ]);
  assert.equal(plans.find((plan) => plan.key === 'pro')?.monthlyPriceMinor, 2900);

  const freeSnapshot = billing.entitlementSnapshot(1);
  assert.equal(freeSnapshot.planKey, 'free');
  assert.equal(freeSnapshot.entitlements.voice?.enabled, false);
  assert.equal(freeSnapshot.entitlements['agents.create']?.quantityLimit, 2);
  assert.equal(billing.creditAccount(1).availableCredits, 1000);

  const trial = billing.activateTrial(1, 1);
  assert.equal(trial.planKey, 'pro');
  assert.equal(trial.endsAt, '2026-08-08T00:00:00.000Z');
  assert.equal(billing.activateTrial(1, 1).id, trial.id);
  assert.equal(billing.creditAccount(1).availableCredits, 10000);

  const trialSnapshot = billing.entitlementSnapshot(1);
  assert.equal(trialSnapshot.planKey, 'pro');
  assert.equal(trialSnapshot.subscriptionState, 'trialing');
  assert.equal(trialSnapshot.entitlements.voice?.enabled, true);
  assert.equal(trialSnapshot.entitlements.voice?.source, 'plan:pro');
  assert.throws(
    () => billing.assertEntitled(1, 'agents.create', 20, 1),
    (error) => error instanceof BillingError && error.code === 'ENTITLEMENT_LIMIT_EXCEEDED',
  );

  const overridden = billing.grantEntitlement({
    workspaceId: 1,
    feature: 'agents.create',
    enabled: true,
    quantityLimit: 50,
    sourceType: 'enterprise',
    sourceRef: 'contract-1',
    priority: 200,
  });
  assert.equal(overridden.entitlements['agents.create']?.quantityLimit, 50);
  assert.equal(overridden.entitlements['agents.create']?.source, 'enterprise:contract-1');

  currentNow = new Date('2026-08-09T00:00:00.000Z');
  const expiredTrial = billing.entitlementSnapshot(1);
  assert.equal(expiredTrial.planKey, 'free');
  assert.equal(expiredTrial.subscriptionState, 'expired');
  assert.equal(expiredTrial.entitlements.voice?.enabled, false);

  db.run(`
    INSERT INTO workspaces (id, name, slug) VALUES (2, 'Second', 'second');
    INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
    VALUES (2, 1, 'owner', 'active');
  `);
  assert.throws(
    () => billing.activateTrial(2, 1),
    (error) => error instanceof BillingError && error.code === 'TRIAL_NOT_ELIGIBLE',
  );
  const trialLedgerCount = db.query<{ count: number }>(`
    SELECT COUNT(*) AS count
    FROM credit_ledger_entries
    WHERE workspace_id = 1 AND source_type = 'trial';
  `);
  assert.equal(Number(trialLedgerCount[0]?.count), 1);
});

test('credit reservations settle release and refund without breaking ledger invariants', () => {
  billing.activateTrial(1, 1);
  const reservation = billing.reserveCredits({
    workspaceId: 1,
    idempotencyKey: 'run-1',
    meter: 'llm.tokens',
    credits: 6000,
  });
  assert.equal(reservation.state, 'reserved');
  assert.deepEqual(billing.creditAccount(1), {
    workspaceId: 1,
    availableCredits: 4000,
    reservedCredits: 6000,
    spentCredits: 0,
    updatedAt: billing.creditAccount(1).updatedAt,
  });
  assert.throws(
    () => billing.reserveCredits({
      workspaceId: 1,
      idempotencyKey: 'run-over-limit',
      meter: 'llm.tokens',
      credits: 5000,
    }),
    (error) => error instanceof BillingError && error.code === 'CREDIT_LIMIT_EXCEEDED',
  );

  const usage = billing.settleReservation({
    workspaceId: 1,
    reservationKey: 'run-1',
    usageIdempotencyKey: 'usage-1',
    quantity: 2500,
    actualCredits: 4000,
    resourceType: 'run',
    resourceId: '42',
  });
  assert.equal(usage.creditsCharged, 4000);
  assert.equal(billing.settleReservation({
    workspaceId: 1,
    reservationKey: 'run-1',
    usageIdempotencyKey: 'usage-1',
    quantity: 2500,
    actualCredits: 4000,
  }).id, usage.id);
  assert.deepEqual(accountBalances(billing.creditAccount(1)), [6000, 0, 4000]);

  billing.reserveCredits({
    workspaceId: 1,
    idempotencyKey: 'run-failed',
    meter: 'tool.runtime',
    credits: 2000,
  });
  assert.deepEqual(accountBalances(billing.creditAccount(1)), [4000, 2000, 4000]);
  assert.equal(billing.releaseReservation(1, 'run-failed').state, 'released');
  assert.equal(billing.releaseReservation(1, 'run-failed').state, 'released');
  assert.deepEqual(accountBalances(billing.creditAccount(1)), [6000, 0, 4000]);

  billing.refundUsage({
    workspaceId: 1,
    usageEventId: usage.id,
    credits: 1500,
    idempotencyKey: 'refund-1',
    sourceRef: 'refund-case-1',
  });
  assert.deepEqual(accountBalances(billing.creditAccount(1)), [7500, 0, 2500]);
  assert.throws(
    () => billing.refundUsage({
      workspaceId: 1,
      usageEventId: usage.id,
      credits: 3000,
      idempotencyKey: 'refund-too-large',
      sourceRef: 'refund-case-2',
    }),
    (error) => error instanceof BillingError && error.code === 'REFUND_LIMIT_EXCEEDED',
  );

  const ledgerTotals = db.query<{
    available: number;
    reserved: number;
    spent: number;
  }>(`
    SELECT
      SUM(available_delta) AS available,
      SUM(reserved_delta) AS reserved,
      SUM(spent_delta) AS spent
    FROM credit_ledger_entries
    WHERE workspace_id = 1;
  `)[0];
  assert.deepEqual(
    [Number(ledgerTotals?.available), Number(ledgerTotals?.reserved), Number(ledgerTotals?.spent)],
    accountBalances(billing.creditAccount(1)),
  );
  assert.throws(() => db.run('UPDATE usage_events SET quantity = 0 WHERE id = 1;'), /immutable/);
  assert.throws(() => db.run('DELETE FROM credit_ledger_entries WHERE id = 1;'), /immutable/);
});

test('conditional reservations prevent competing requests from exceeding quota', () => {
  const secondRepository = new BillingRepository(db, () => FIXED_NOW);
  const first = billing.reserveCredits({
    workspaceId: 1,
    idempotencyKey: 'quota-a',
    meter: 'hosted.run',
    credits: 700,
  });
  assert.equal(first.reservedCredits, 700);
  assert.throws(
    () => secondRepository.reserveCredits({
      workspaceId: 1,
      idempotencyKey: 'quota-b',
      meter: 'hosted.run',
      credits: 700,
    }),
    (error) => error instanceof BillingError && error.code === 'CREDIT_LIMIT_EXCEEDED',
  );
  assert.deepEqual(accountBalances(billing.creditAccount(1)), [300, 700, 0]);
});

function accountBalances(account: ReturnType<BillingRepository['creditAccount']>): number[] {
  return [account.availableCredits, account.reservedCredits, account.spentCredits];
}
