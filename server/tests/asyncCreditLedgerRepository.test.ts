import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAsyncSqliteDatabase } from '../src/db/asyncDatabaseFactory';
import { type AsyncSqliteDatabase } from '../src/db/asyncSqlite';
import { AsyncCreditLedgerRepository } from '../src/services/asyncCreditLedgerRepository';
import { AsyncUserRepository } from '../src/services/asyncUserRepository';
import { AsyncWorkspaceRepository } from '../src/services/asyncWorkspaceRepository';
import { BillingError } from '../src/services/billingTypes';

const NOW = new Date('2026-08-15T12:00:00.000Z');

function createDatabase(): { database: AsyncSqliteDatabase; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'primalthrum-async-credit-ledger-'));
  return {
    database: createAsyncSqliteDatabase(join(root, 'database.sqlite')),
    root,
  };
}

test('async credit ledger preserves reservation, settlement, refund, and tenant invariants', async () => {
  const { database, root } = createDatabase();
  const users = new AsyncUserRepository(database);
  const workspaces = new AsyncWorkspaceRepository(database);
  const ledger = new AsyncCreditLedgerRepository(database, () => NOW);
  try {
    const owner = await users.createUser('async-ledger@example.com', 'hash', true);
    const workspace = await workspaces.create(owner.id, 'Credit Ledger');
    const isolated = await workspaces.create(owner.id, 'Credit Isolated');
    assert.deepEqual(balances(await ledger.account(workspace.id)), [1000, 0, 0]);
    assert.deepEqual(balances(await ledger.account(isolated.id)), [1000, 0, 0]);

    const reservation = await ledger.reserve({
      workspaceId: workspace.id,
      idempotencyKey: 'run-1',
      meter: 'run.total',
      credits: 600,
    });
    assert.equal(reservation.state, 'reserved');
    assert.equal(reservation.createdAt.endsWith('Z'), true);
    assert.equal((await ledger.reserve({
      workspaceId: workspace.id,
      idempotencyKey: 'run-1',
      meter: 'run.total',
      credits: 600,
    })).id, reservation.id);
    assert.deepEqual(balances(await ledger.account(workspace.id)), [400, 600, 0]);

    const usage = await ledger.settle({
      workspaceId: workspace.id,
      reservationKey: 'run-1',
      usageIdempotencyKey: 'usage-1',
      quantity: 2500,
      actualCredits: 400,
      resourceType: 'run',
      resourceId: '42',
      metadata: { ratedEventCount: 3 },
    });
    assert.equal(usage.creditsCharged, 400);
    assert.equal(usage.occurredAt, NOW.toISOString());
    assert.equal((await ledger.settle({
      workspaceId: workspace.id,
      reservationKey: 'run-1',
      usageIdempotencyKey: 'usage-1',
      quantity: 2500,
      actualCredits: 400,
    })).id, usage.id);
    assert.deepEqual(balances(await ledger.account(workspace.id)), [600, 0, 400]);

    const failed = await ledger.reserve({
      workspaceId: workspace.id,
      idempotencyKey: 'run-failed',
      meter: 'run.total',
      credits: 300,
    });
    assert.equal((await ledger.release(workspace.id, 'run-failed')).state, 'released');
    assert.equal((await ledger.release(workspace.id, 'run-failed')).id, failed.id);
    assert.deepEqual(balances(await ledger.account(workspace.id)), [600, 0, 400]);

    await ledger.refund({
      workspaceId: workspace.id,
      usageEventId: usage.id,
      credits: 150,
      idempotencyKey: 'refund-1',
      sourceRef: 'case-1',
    });
    assert.deepEqual(balances(await ledger.account(workspace.id)), [750, 0, 250]);
    await assert.rejects(
      ledger.refund({
        workspaceId: workspace.id,
        usageEventId: usage.id,
        credits: 300,
        idempotencyKey: 'refund-too-large',
        sourceRef: 'case-2',
      }),
      (error) => error instanceof BillingError && error.code === 'REFUND_LIMIT_EXCEEDED',
    );
    assert.deepEqual(balances(await ledger.account(isolated.id)), [1000, 0, 0]);

    await assert.rejects(
      database.execute({ text: 'DELETE FROM usage_events WHERE id = $1;', values: [usage.id] }),
      /immutable/,
    );
    await assert.rejects(
      database.execute({
        text: 'DELETE FROM credit_ledger_entries WHERE workspace_id = $1;',
        values: [workspace.id],
      }),
      /immutable/,
    );
  } finally {
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('async credit reservations serialize competing quota claims', async () => {
  const { database, root } = createDatabase();
  const users = new AsyncUserRepository(database);
  const workspaces = new AsyncWorkspaceRepository(database);
  const ledger = new AsyncCreditLedgerRepository(database, () => NOW);
  try {
    const owner = await users.createUser('async-quota@example.com', 'hash', true);
    const workspace = await workspaces.create(owner.id, 'Concurrent Quota');
    const results = await Promise.allSettled([
      ledger.reserve({
        workspaceId: workspace.id,
        idempotencyKey: 'quota-a',
        meter: 'hosted.runs',
        credits: 700,
      }),
      ledger.reserve({
        workspaceId: workspace.id,
        idempotencyKey: 'quota-b',
        meter: 'hosted.runs',
        credits: 700,
      }),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result) => result.status === 'rejected');
    assert.equal(
      rejected?.status === 'rejected'
        && rejected.reason instanceof BillingError
        && rejected.reason.code === 'CREDIT_LIMIT_EXCEEDED',
      true,
    );
    assert.deepEqual(balances(await ledger.account(workspace.id)), [300, 700, 0]);
  } finally {
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function balances(account: Awaited<ReturnType<AsyncCreditLedgerRepository['account']>>): number[] {
  return [account.availableCredits, account.reservedCredits, account.spentCredits];
}
