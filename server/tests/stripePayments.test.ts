import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Server } from 'node:http';
import { after, before, test } from 'node:test';

import { createApp } from '../src/app';
import type { PaymentProviderAdapter } from '../src/services/paymentProvider';
import { StripePaymentAdapter } from '../src/services/stripePaymentAdapter';
import { verifyStripeWebhookSignature } from '../src/services/stripeWebhookSignature';
import { bootstrapAdminSession } from './authTestHelpers';

const WEBHOOK_SECRET = 'whsec_test_secret';

class FakePaymentAdapter implements PaymentProviderAdapter {
  readonly name = 'stripe';
  readonly checkoutCalls: Parameters<PaymentProviderAdapter['createCheckoutSession']>[0][] = [];
  readonly changeCalls: Parameters<PaymentProviderAdapter['changeSubscription']>[0][] = [];
  readonly cancelCalls: Parameters<PaymentProviderAdapter['scheduleCancellation']>[0][] = [];

  async createCustomer(): Promise<{ id: string }> {
    return { id: 'cus_1' };
  }

  async createCheckoutSession(
    input: Parameters<PaymentProviderAdapter['createCheckoutSession']>[0],
  ): Promise<{ id: string; url: string; expiresAt: string | null }> {
    this.checkoutCalls.push(input);
    return { id: 'cs_1', url: 'https://checkout.stripe.test/cs_1', expiresAt: null };
  }

  async createPortalSession(): Promise<{ url: string }> {
    return { url: 'https://billing.stripe.test/session' };
  }

  async changeSubscription(
    input: Parameters<PaymentProviderAdapter['changeSubscription']>[0],
  ): Promise<void> {
    this.changeCalls.push(input);
  }

  async scheduleCancellation(
    input: Parameters<PaymentProviderAdapter['scheduleCancellation']>[0],
  ): Promise<void> {
    this.cancelCalls.push(input);
  }
}

test('Stripe signature verification accepts an exact current payload only', () => {
  const rawBody = '{"id":"evt_1"}';
  const timestamp = 1_800_000_000;
  const signature = createHmac('sha256', WEBHOOK_SECRET)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  const now = () => new Date(timestamp * 1000);
  assert.equal(
    verifyStripeWebhookSignature(rawBody, `t=${timestamp},v1=${signature}`, WEBHOOK_SECRET, now),
    timestamp,
  );
  assert.throws(
    () => verifyStripeWebhookSignature(`${rawBody} `, `t=${timestamp},v1=${signature}`, WEBHOOK_SECRET, now),
    /signature is invalid/,
  );
  assert.throws(
    () => verifyStripeWebhookSignature(
      rawBody,
      `t=${timestamp - 301},v1=${signature}`,
      WEBHOOK_SECRET,
      now,
    ),
    /outside tolerance/,
  );
});

test('Stripe adapter sends hosted checkout metadata and provider idempotency keys', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    return new Response(JSON.stringify({
      id: 'cs_test_123',
      url: 'https://checkout.stripe.test/cs_test_123',
      expires_at: 1_800_000_000,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const adapter = new StripePaymentAdapter('sk_test_123', fakeFetch, 'https://stripe.test');
  const checkout = await adapter.createCheckoutSession({
    workspaceId: 42,
    planKey: 'pro',
    priceRef: 'price_pro',
    customerRef: 'cus_123',
    successUrl: 'https://app.test/app/billing?checkout=success',
    cancelUrl: 'https://app.test/app/billing?checkout=canceled',
    idempotencyKey: 'checkout-42',
  });
  assert.equal(checkout.id, 'cs_test_123');
  assert.equal(requests[0]?.url, 'https://stripe.test/v1/checkout/sessions');
  assert.equal(new Headers(requests[0]?.init?.headers).get('idempotency-key'), 'checkout-42');
  const body = new URLSearchParams(String(requests[0]?.init?.body));
  assert.equal(body.get('mode'), 'subscription');
  assert.equal(body.get('line_items[0][price]'), 'price_pro');
  assert.equal(body.get('metadata[workspace_id]'), '42');
  assert.equal(body.get('subscription_data[metadata][plan_key]'), 'pro');
});

let rootDir = '';
let server: Server;
let baseUrl = '';
let authHeaders: Record<string, string> = {};
let adapter: FakePaymentAdapter;

before(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'primalthrum-stripe-api-'));
  adapter = new FakePaymentAdapter();
  const app = createApp({
    dbPath: join(rootDir, 'platform.sqlite'),
    documentStorageDir: join(rootDir, 'documents'),
    generatedAgentsDir: join(rootDir, 'generated-agents'),
    logger: { log: () => undefined },
    paymentAdapter: adapter,
    paymentPriceRefs: { pro: 'price_pro', team: 'price_team' },
    publicAppUrl: 'https://app.primalthrum.test',
    stripeWebhookSecret: WEBHOOK_SECRET,
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;
  authHeaders = await bootstrapAdminSession(baseUrl, 'stripe-owner@example.com');
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(rootDir, { recursive: true, force: true });
});

test('billing API completes checkout and lets verified webhooks provision access', async () => {
  const checkoutResponse = await fetch(`${baseUrl}/api/billing/checkout`, {
    method: 'POST',
    headers: {
      ...authHeaders,
      'content-type': 'application/json',
      'idempotency-key': 'checkout-api-1',
    },
    body: JSON.stringify({ planKey: 'pro' }),
  });
  assert.equal(checkoutResponse.status, 201);
  const checkout = await checkoutResponse.json() as { checkoutUrl: string };
  assert.equal(checkout.checkoutUrl, 'https://checkout.stripe.test/cs_1');
  assert.equal(adapter.checkoutCalls.length, 1);
  assert.match(adapter.checkoutCalls[0]?.successUrl ?? '', /app\/billing\?checkout=success/);

  const replayResponse = await fetch(`${baseUrl}/api/billing/checkout`, {
    method: 'POST',
    headers: {
      ...authHeaders,
      'content-type': 'application/json',
      'idempotency-key': 'checkout-api-1',
    },
    body: JSON.stringify({ planKey: 'pro' }),
  });
  assert.equal(replayResponse.status, 200);
  assert.equal(adapter.checkoutCalls.length, 1);

  const now = Math.floor(Date.now() / 1000);
  const subscription = webhookEvent('evt_api_subscription', 'customer.subscription.updated', now, {
    id: 'sub_api_1',
    customer: 'cus_1',
    status: 'active',
    cancel_at_period_end: false,
    current_period_start: now,
    current_period_end: now + 2_592_000,
    metadata: { workspace_id: '1', plan_key: 'pro' },
    items: { data: [{ id: 'si_api_1', price: { id: 'price_pro' } }] },
  });
  assert.equal((await sendWebhook(subscription)).status, 200);

  const invoice = webhookEvent('evt_api_invoice', 'invoice.paid', now + 1, {
    id: 'in_api_1',
    customer: 'cus_1',
    subscription: 'sub_api_1',
    status: 'paid',
    paid: true,
    amount_due: 2900,
    amount_paid: 2900,
    currency: 'usd',
    period_start: now,
    period_end: now + 2_592_000,
  });
  assert.equal((await sendWebhook(invoice)).status, 200);

  const summaryResponse = await fetch(`${baseUrl}/api/billing/summary`, { headers: authHeaders });
  assert.equal(summaryResponse.status, 200);
  const summary = await summaryResponse.json() as {
    subscription: { state: string; planKey: string };
    creditAccount: { availableCredits: number };
    invoices: Array<{ providerInvoiceRef: string }>;
  };
  assert.equal(summary.subscription.state, 'active');
  assert.equal(summary.subscription.planKey, 'pro');
  assert.equal(summary.creditAccount.availableCredits, 26_000);
  assert.equal(summary.invoices[0]?.providerInvoiceRef, 'in_api_1');

  const badSignature = await fetch(`${baseUrl}/api/webhooks/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': `t=${now},v1=bad` },
    body: JSON.stringify(invoice),
  });
  assert.equal(badSignature.status, 400);
});

test('billing API delegates changes portal and cancellation while webhooks stay authoritative', async () => {
  const change = await fetch(`${baseUrl}/api/billing/subscription/change`, {
    method: 'POST',
    headers: {
      ...authHeaders,
      'content-type': 'application/json',
      'idempotency-key': 'change-api-1',
    },
    body: JSON.stringify({ planKey: 'team' }),
  });
  assert.equal(change.status, 202);
  const pending = await change.json() as { planKey: string; pendingPlanKey: string };
  assert.equal(pending.planKey, 'pro');
  assert.equal(pending.pendingPlanKey, 'team');
  assert.equal(adapter.changeCalls[0]?.priceRef, 'price_team');

  const now = Math.floor(Date.now() / 1000);
  const changed = webhookEvent('evt_api_plan_changed', 'customer.subscription.updated', now + 5, {
    id: 'sub_api_1',
    customer: 'cus_1',
    status: 'active',
    cancel_at_period_end: false,
    current_period_start: now,
    current_period_end: now + 2_592_000,
    metadata: { workspace_id: '1', plan_key: 'pro' },
    items: { data: [{ id: 'si_api_1', price: { id: 'price_team' } }] },
  });
  assert.equal((await sendWebhook(changed)).status, 200);

  const portal = await fetch(`${baseUrl}/api/billing/portal`, {
    method: 'POST',
    headers: authHeaders,
  });
  assert.equal(portal.status, 200);
  assert.deepEqual(await portal.json(), { url: 'https://billing.stripe.test/session' });

  const cancel = await fetch(`${baseUrl}/api/billing/subscription/cancel`, {
    method: 'POST',
    headers: { ...authHeaders, 'idempotency-key': 'cancel-api-1' },
  });
  assert.equal(cancel.status, 202);
  assert.equal(adapter.cancelCalls[0]?.subscriptionRef, 'sub_api_1');

  const summaryResponse = await fetch(`${baseUrl}/api/billing/summary`, { headers: authHeaders });
  const summary = await summaryResponse.json() as { subscription: { state: string; planKey: string } };
  assert.equal(summary.subscription.state, 'active');
  assert.equal(summary.subscription.planKey, 'team');
});

async function sendWebhook(event: Record<string, unknown>): Promise<Response> {
  const rawBody = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', WEBHOOK_SECRET)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  return fetch(`${baseUrl}/api/webhooks/stripe`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': `t=${timestamp},v1=${signature}`,
    },
    body: rawBody,
  });
}

function webhookEvent(
  id: string,
  type: string,
  created: number,
  object: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id,
    type,
    created,
    livemode: false,
    api_version: '2025-06-30.basil',
    data: { object },
  };
}
