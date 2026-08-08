import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAsyncSqliteDatabase } from '../src/db/asyncDatabaseFactory';
import { type AsyncSqliteDatabase } from '../src/db/asyncSqlite';
import { AsyncBillingPlanRepository } from '../src/services/asyncBillingPlanRepository';
import { AsyncCreditLedgerRepository } from '../src/services/asyncCreditLedgerRepository';
import { AsyncPaymentLifecycleRepository } from '../src/services/asyncPaymentLifecycleRepository';
import { AsyncUserRepository } from '../src/services/asyncUserRepository';
import { AsyncWorkspaceRepository } from '../src/services/asyncWorkspaceRepository';
import { type PaymentWebhookEvent } from '../src/services/paymentTypes';
import { PaymentWebhookProcessor } from '../src/services/paymentWebhookProcessor';

const NOW = new Date('2026-08-01T00:00:00.000Z');

function createDatabase(): { database: AsyncSqliteDatabase; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'primalthrum-async-payments-'));
  return {
    database: createAsyncSqliteDatabase(join(root, 'database.sqlite')),
    root,
  };
}

test('async payment lifecycle persists idempotent checkout and ordered subscription state', async () => {
  const { database, root } = createDatabase();
  const users = new AsyncUserRepository(database);
  const workspaces = new AsyncWorkspaceRepository(database);
  const payments = new AsyncPaymentLifecycleRepository(database, () => NOW);
  try {
    const owner = await users.createUser('async-payments@example.com', 'hash', true);
    const workspace = await workspaces.create(owner.id, 'Async Payments');
    await payments.configurePrice('stripe', 'pro', 'price_pro');
    await payments.upsertCustomer({
      workspaceId: workspace.id,
      provider: 'stripe',
      providerCustomerRef: 'cus_async',
      email: owner.email,
    });
    const checkout = await payments.recordCheckout({
      workspaceId: workspace.id,
      provider: 'stripe',
      idempotencyKey: 'checkout-async',
      providerSessionRef: 'cs_async',
      planKey: 'pro',
      checkoutUrl: 'https://checkout.test/cs_async',
      createdByUserId: owner.id,
    });
    const replay = await payments.recordCheckout({
      workspaceId: workspace.id,
      provider: 'stripe',
      idempotencyKey: 'checkout-async',
      providerSessionRef: 'cs_replay',
      planKey: 'pro',
      checkoutUrl: 'https://checkout.test/cs_replay',
      createdByUserId: owner.id,
    });
    assert.equal(replay.id, checkout.id);
    assert.equal(replay.providerSessionRef, 'cs_async');
    await payments.completeCheckout('stripe', 'cs_async');
    assert.equal((await payments.checkoutByKey(workspace.id, 'stripe', 'checkout-async'))?.status, 'complete');

    assert.equal(await payments.applySubscriptionState({
      workspaceId: workspace.id,
      provider: 'stripe',
      eventRef: 'evt_active',
      eventCreated: 200,
      state: 'active',
      planKey: 'pro',
      customerRef: 'cus_async',
      subscriptionRef: 'sub_async',
      priceRef: 'price_pro',
    }), true);
    assert.equal(await payments.applySubscriptionState({
      workspaceId: workspace.id,
      provider: 'stripe',
      eventRef: 'evt_stale',
      eventCreated: 100,
      state: 'past_due',
      planKey: 'pro',
    }), false);
    assert.equal((await payments.subscription(workspace.id)).state, 'active');
    assert.equal(
      await payments.workspaceForProviderObject('stripe', '', 'sub_async'),
      workspace.id,
    );

    await payments.upsertInvoice({
      workspaceId: workspace.id,
      provider: 'stripe',
      invoiceRef: 'in_async',
      status: 'open',
      amountDueMinor: 2900,
    });
    await payments.upsertInvoice({
      workspaceId: workspace.id,
      provider: 'stripe',
      invoiceRef: 'in_async',
      status: 'paid',
      amountDueMinor: 2900,
      amountPaidMinor: 2900,
    });
    assert.deepEqual(
      (await payments.listInvoices(workspace.id)).map((invoice) => [
        invoice.providerInvoiceRef,
        invoice.status,
        invoice.amountPaidMinor,
      ]),
      [['in_async', 'paid', 2900]],
    );
  } finally {
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('async webhook claims are exclusive and failed deliveries can retry', async () => {
  const { database, root } = createDatabase();
  const payments = new AsyncPaymentLifecycleRepository(database, () => NOW);
  const event = webhookEvent('evt_retry', 'customer.created', 100, { id: 'cus_retry' });
  try {
    assert.equal(await payments.receiveWebhook('stripe', event, '{}', 100), true);
    assert.equal(await payments.receiveWebhook('stripe', event, '{}', 100), false);
    await payments.finishWebhook('stripe', event.id, 'failed', null, 'temporary failure');
    assert.equal(await payments.receiveWebhook('stripe', event, '{}', 100), true);
    await payments.finishWebhook('stripe', event.id, 'ignored', null);
    assert.equal(await payments.receiveWebhook('stripe', event, '{}', 100), false);
  } finally {
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('async webhook processor applies subscription and invoice credits once', async () => {
  const { database, root } = createDatabase();
  const users = new AsyncUserRepository(database);
  const workspaces = new AsyncWorkspaceRepository(database);
  const payments = new AsyncPaymentLifecycleRepository(database, () => NOW);
  const plans = new AsyncBillingPlanRepository(database);
  const credits = new AsyncCreditLedgerRepository(database, () => NOW);
  const processor = new PaymentWebhookProcessor(payments, {
    listPlans: () => plans.list(),
    grantCredits: (input) => credits.grant(input),
  });
  try {
    const owner = await users.createUser('async-webhooks@example.com', 'hash', true);
    const workspace = await workspaces.create(owner.id, 'Async Webhooks');
    await payments.configurePrice('stripe', 'pro', 'price_pro');
    const subscription = webhookEvent('evt_subscription', 'customer.subscription.updated', 100, {
      id: 'sub_async',
      customer: 'cus_async',
      status: 'active',
      current_period_start: 100,
      current_period_end: 2_592_100,
      metadata: { workspace_id: String(workspace.id), plan_key: 'pro' },
      items: { data: [{ id: 'si_async', price: { id: 'price_pro' } }] },
    });
    assert.equal((await processor.process(subscription, JSON.stringify(subscription), 100)).status, 'processed');
    const invoice = webhookEvent('evt_invoice', 'invoice.paid', 200, {
      id: 'in_async',
      customer: 'cus_async',
      subscription: 'sub_async',
      status: 'paid',
      paid: true,
      currency: 'usd',
      amount_due: 2900,
      amount_paid: 2900,
      period_start: 100,
      period_end: 2_592_100,
    });
    assert.equal((await processor.process(invoice, JSON.stringify(invoice), 200)).status, 'processed');
    assert.equal((await processor.process(invoice, JSON.stringify(invoice), 200)).status, 'duplicate');
    assert.equal((await credits.account(workspace.id)).availableCredits, 26_000);
    assert.equal((await payments.listInvoices(workspace.id))[0]?.providerInvoiceRef, 'in_async');
  } finally {
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('failed invoice credit grants are recovered by Webhook retry', async () => {
  const { database, root } = createDatabase();
  const users = new AsyncUserRepository(database);
  const workspaces = new AsyncWorkspaceRepository(database);
  const payments = new AsyncPaymentLifecycleRepository(database, () => NOW);
  const plans = new AsyncBillingPlanRepository(database);
  const credits = new AsyncCreditLedgerRepository(database, () => NOW);
  let failGrant = true;
  const processor = new PaymentWebhookProcessor(payments, {
    listPlans: () => plans.list(),
    grantCredits: (input) => {
      if (failGrant) {
        failGrant = false;
        throw new Error('temporary credit ledger failure');
      }
      return credits.grant(input);
    },
  });
  try {
    const owner = await users.createUser('async-webhook-retry@example.com', 'hash', true);
    const workspace = await workspaces.create(owner.id, 'Async Webhook Retry');
    await payments.configurePrice('stripe', 'pro', 'price_pro');
    const subscription = webhookEvent('evt_retry_subscription', 'customer.subscription.updated', 100, {
      id: 'sub_retry',
      customer: 'cus_retry',
      status: 'active',
      current_period_start: 100,
      current_period_end: 2_592_100,
      metadata: { workspace_id: String(workspace.id), plan_key: 'pro' },
      items: { data: [{ id: 'si_retry', price: { id: 'price_pro' } }] },
    });
    await processor.process(subscription, JSON.stringify(subscription), 100);
    const invoice = webhookEvent('evt_retry_invoice', 'invoice.paid', 200, {
      id: 'in_retry',
      customer: 'cus_retry',
      subscription: 'sub_retry',
      status: 'paid',
      paid: true,
      amount_due: 2900,
      amount_paid: 2900,
      period_start: 100,
      period_end: 2_592_100,
    });
    await assert.rejects(
      processor.process(invoice, JSON.stringify(invoice), 200),
      /temporary credit ledger failure/,
    );
    assert.equal((await credits.account(workspace.id)).availableCredits, 1000);
    assert.equal((await processor.process(invoice, JSON.stringify(invoice), 200)).status, 'processed');
    assert.equal((await credits.account(workspace.id)).availableCredits, 26_000);
  } finally {
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function webhookEvent(
  id: string,
  type: string,
  created: number,
  object: Record<string, unknown>,
): PaymentWebhookEvent {
  return {
    id,
    type,
    created,
    livemode: false,
    api_version: '2025-06-30.basil',
    data: { object },
  };
}
