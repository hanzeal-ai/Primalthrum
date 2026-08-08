import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { SqliteDatabase } from '../src/db/sqlite';
import { createSqliteDatabase } from '../src/db/databaseFactory';
import { BillingRepository } from '../src/services/billingRepository';
import { PaymentLifecycleRepository } from '../src/services/paymentLifecycleRepository';
import type { PaymentWebhookEvent } from '../src/services/paymentTypes';
import { PaymentWebhookProcessor } from '../src/services/paymentWebhookProcessor';

let rootDir = '';
let db: SqliteDatabase;
let billing: BillingRepository;
let payments: PaymentLifecycleRepository;
let processor: PaymentWebhookProcessor;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'primalthrum-payment-webhooks-'));
  db = createSqliteDatabase(join(rootDir, 'platform.sqlite'));
  billing = new BillingRepository(db, () => new Date('2026-08-01T00:00:00.000Z'));
  payments = new PaymentLifecycleRepository(db);
  processor = new PaymentWebhookProcessor(payments, billing);
  payments.configurePrice('stripe', 'pro', 'price_pro_monthly');
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

test('signed-provider events drive an idempotent subscription and credit lifecycle', async () => {
  const created = subscriptionEvent('evt_sub_created', 100, 'active');
  assert.deepEqual(await processor.process(created, JSON.stringify(created), 100), {
    eventId: 'evt_sub_created',
    status: 'processed',
    workspaceId: 1,
  });
  assert.equal(payments.subscription(1).state, 'active');
  assert.equal(payments.subscription(1).providerSubscriptionRef, 'sub_123');

  const invoicePaid = invoiceEvent('evt_invoice_paid', 200, 'invoice.paid', 'in_001', true);
  await processor.process(invoicePaid, JSON.stringify(invoicePaid), 200);
  assert.equal(payments.subscription(1).state, 'active');
  assert.equal(billing.creditAccount(1).availableCredits, 26_000);
  assert.equal(payments.listInvoices(1)[0]?.providerInvoiceRef, 'in_001');

  assert.equal(
    (await processor.process(invoicePaid, JSON.stringify(invoicePaid), 200)).status,
    'duplicate',
  );
  assert.equal(billing.creditAccount(1).availableCredits, 26_000);

  const sameInvoiceUpdated = invoiceEvent(
    'evt_invoice_paid_updated',
    225,
    'invoice.updated',
    'in_001',
    true,
  );
  await processor.process(sameInvoiceUpdated, JSON.stringify(sameInvoiceUpdated), 225);
  assert.equal(billing.creditAccount(1).availableCredits, 26_000);

  const staleFailure = invoiceEvent(
    'evt_invoice_failure_stale',
    150,
    'invoice.payment_failed',
    'in_001',
    false,
  );
  await processor.process(staleFailure, JSON.stringify(staleFailure), 150);
  assert.equal(payments.subscription(1).state, 'active');

  const currentFailure = invoiceEvent(
    'evt_invoice_failure_current',
    300,
    'invoice.payment_failed',
    'in_002',
    false,
  );
  await processor.process(currentFailure, JSON.stringify(currentFailure), 300);
  assert.equal(payments.subscription(1).state, 'past_due');
  assert.equal(payments.subscription(1).graceEndsAt, '1970-01-08T00:05:00.000Z');
  assert.equal(billing.entitlementSnapshot(1).subscriptionState, 'restricted');
  assert.equal(billing.entitlementSnapshot(1).planKey, 'free');

  const renewal = invoiceEvent('evt_invoice_renewal', 400, 'invoice.paid', 'in_002', true);
  await processor.process(renewal, JSON.stringify(renewal), 400);
  assert.equal(payments.subscription(1).state, 'active');
  assert.equal(billing.creditAccount(1).availableCredits, 51_000);

  const events = db.query<{ status: string }>(`
    SELECT status FROM payment_webhook_events ORDER BY id;
  `);
  assert.deepEqual(events.map((event) => event.status), [
    'processed',
    'processed',
    'processed',
    'processed',
    'processed',
    'processed',
  ]);
});

test('checkout customer mapping supports cancellation and full refund records', async () => {
  db.run(`
    INSERT INTO users (id, workspace_id, email, password_hash, role)
    VALUES (10, 1, 'owner@example.com', 'hash', 'admin');
  `);
  payments.recordCheckout({
    workspaceId: 1,
    provider: 'stripe',
    idempotencyKey: 'checkout-1',
    providerSessionRef: 'cs_123',
    planKey: 'pro',
    checkoutUrl: 'https://checkout.stripe.test/cs_123',
    createdByUserId: 10,
  });
  const checkout = event('evt_checkout', 'checkout.session.completed', 100, {
    id: 'cs_123',
    customer: 'cus_123',
    metadata: { workspace_id: '1', plan_key: 'pro' },
    customer_details: { email: 'owner@example.com' },
  });
  await processor.process(checkout, JSON.stringify(checkout), 100);
  assert.equal(payments.checkoutByKey(1, 'stripe', 'checkout-1')?.status, 'complete');
  assert.equal(payments.customer(1, 'stripe')?.providerCustomerRef, 'cus_123');

  await processor.process(
    subscriptionEvent('evt_sub_created', 200, 'active'),
    '{}',
    200,
  );
  const cancelScheduled = subscriptionEvent('evt_sub_cancel_scheduled', 300, 'active', true);
  await processor.process(cancelScheduled, JSON.stringify(cancelScheduled), 300);
  assert.equal(payments.subscription(1).state, 'cancel_at_period_end');

  const canceled = subscriptionEvent('evt_sub_deleted', 400, 'canceled');
  canceled.type = 'customer.subscription.deleted';
  await processor.process(canceled, JSON.stringify(canceled), 400);
  assert.equal(payments.subscription(1).state, 'canceled');
  assert.equal(billing.entitlementSnapshot(1).planKey, 'free');

  const refund = event('evt_charge_refunded', 'charge.refunded', 500, {
    id: 'ch_123',
    customer: 'cus_123',
    invoice: 'in_001',
    amount: 2900,
    amount_refunded: 2900,
    refunds: {
      data: [{
        id: 're_123',
        charge: 'ch_123',
        amount: 2900,
        currency: 'usd',
        status: 'succeeded',
        created: 500,
      }],
    },
  });
  await processor.process(refund, JSON.stringify(refund), 500);
  assert.equal(payments.subscription(1).state, 'refunded');
  assert.equal(
    db.query<{ status: string }>(`SELECT status FROM billing_refunds WHERE provider_refund_ref = 're_123';`)[0]?.status,
    'succeeded',
  );
});

test('unsupported events are persisted as ignored', async () => {
  const unsupported = event('evt_unknown', 'customer.created', 100, { id: 'cus_123' });
  assert.equal(
    (await processor.process(unsupported, JSON.stringify(unsupported), 100)).status,
    'ignored',
  );
  assert.equal(
    db.query<{ status: string }>(`SELECT status FROM payment_webhook_events WHERE provider_event_ref = 'evt_unknown';`)[0]?.status,
    'ignored',
  );
});

function subscriptionEvent(
  id: string,
  created: number,
  status: string,
  cancelAtPeriodEnd = false,
): PaymentWebhookEvent {
  return event(id, 'customer.subscription.updated', created, {
    id: 'sub_123',
    customer: 'cus_123',
    status,
    cancel_at_period_end: cancelAtPeriodEnd,
    current_period_start: 100,
    current_period_end: 2_678_500,
    metadata: { workspace_id: '1', plan_key: 'pro' },
    items: {
      data: [{ id: 'si_123', price: { id: 'price_pro_monthly' } }],
    },
  });
}

function invoiceEvent(
  id: string,
  created: number,
  type: string,
  invoiceId: string,
  paid: boolean,
): PaymentWebhookEvent {
  return event(id, type, created, {
    id: invoiceId,
    customer: 'cus_123',
    subscription: 'sub_123',
    status: paid ? 'paid' : 'open',
    paid,
    currency: 'usd',
    amount_due: 2900,
    amount_paid: paid ? 2900 : 0,
    period_start: 100,
    period_end: 2_678_500,
    hosted_invoice_url: `https://invoice.stripe.test/${invoiceId}`,
  });
}

function event(
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
