import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAsyncSqliteDatabase } from '../src/db/asyncDatabaseFactory';
import { type AsyncSqliteDatabase } from '../src/db/asyncSqlite';
import { AsyncCreditLedgerRepository } from '../src/services/asyncCreditLedgerRepository';
import { AsyncEntitlementRepository } from '../src/services/asyncEntitlementRepository';
import { AsyncTrialRepository } from '../src/services/asyncTrialRepository';
import { AsyncUserRepository } from '../src/services/asyncUserRepository';
import { AsyncWorkspaceRepository } from '../src/services/asyncWorkspaceRepository';
import { BillingError } from '../src/services/billingTypes';

const NOW = new Date('2026-08-01T00:00:00.000Z');

function createDatabase(): { database: AsyncSqliteDatabase; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'primalthrum-async-trial-'));
  return {
    database: createAsyncSqliteDatabase(join(root, 'database.sqlite')),
    root,
  };
}

test('async trial activation is atomic, idempotent, and single-use', async () => {
  const { database, root } = createDatabase();
  const users = new AsyncUserRepository(database);
  const workspaces = new AsyncWorkspaceRepository(database);
  const trials = new AsyncTrialRepository(database, () => NOW);
  const credits = new AsyncCreditLedgerRepository(database, () => NOW);
  const entitlements = new AsyncEntitlementRepository(database, () => NOW);
  try {
    const owner = await users.createUser('async-trial@example.com', 'hash', true);
    const workspace = await workspaces.create(owner.id, 'Trial Workspace');
    const second = await workspaces.create(owner.id, 'Second Trial Workspace');
    const trial = await trials.activate(workspace.id, owner.id);
    assert.equal(trial.planKey, 'pro');
    assert.equal(trial.endsAt, '2026-08-08T00:00:00.000Z');
    assert.equal((await trials.activate(workspace.id, owner.id)).id, trial.id);
    assert.equal((await credits.account(workspace.id)).availableCredits, 10_000);
    assert.equal((await entitlements.snapshot(workspace.id)).entitlements.voice?.enabled, true);
    await assert.rejects(
      trials.activate(second.id, owner.id),
      (error) => error instanceof BillingError && error.code === 'TRIAL_NOT_ELIGIBLE',
    );
    await assert.rejects(
      trials.activate(second.id, owner.id, 'enterprise'),
      (error) => error instanceof BillingError && error.code === 'TRIAL_PLAN_INVALID',
    );
    assert.equal((await credits.account(second.id)).availableCredits, 1000);
  } finally {
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('async trial activation admits only one concurrent workspace for a user', async () => {
  const { database, root } = createDatabase();
  const users = new AsyncUserRepository(database);
  const workspaces = new AsyncWorkspaceRepository(database);
  const trials = new AsyncTrialRepository(database, () => NOW);
  try {
    const owner = await users.createUser('async-trial-race@example.com', 'hash', true);
    const first = await workspaces.create(owner.id, 'Trial Race One');
    const second = await workspaces.create(owner.id, 'Trial Race Two');
    const results = await Promise.allSettled([
      trials.activate(first.id, owner.id),
      trials.activate(second.id, owner.id),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result) => result.status === 'rejected');
    assert.equal(
      rejected?.status === 'rejected'
        && rejected.reason instanceof BillingError
        && rejected.reason.code === 'TRIAL_NOT_ELIGIBLE',
      true,
    );
  } finally {
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
