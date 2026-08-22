import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { createApp } from '../src/app';
import { MockPaymentAdapter } from '../src/services/mockPaymentAdapter';
import { bootstrapAdminSession } from './authTestHelpers';

let rootDir = '';
let server: Server;
let baseUrl = '';
let authHeaders: Record<string, string> = {};

before(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'primalthrum-mock-payment-'));
  server = createApp({
    dbPath: join(rootDir, 'platform.sqlite'),
    documentStorageDir: join(rootDir, 'documents'),
    generatedAgentsDir: join(rootDir, 'generated-agents'),
    logger: { log: () => undefined },
    paymentAdapter: new MockPaymentAdapter(),
    paymentPriceRefs: {
      pro: 'mock_price_pro',
      team: 'mock_price_team',
    },
    publicAppUrl: 'http://app.test',
  }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;
  authHeaders = await bootstrapAdminSession(baseUrl, 'mock-payment@example.com');
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(rootDir, { recursive: true, force: true });
});

test('mock payment completes checkout, plan changes, portal, and cancellation locally', async () => {
  const checkout = await post('/api/billing/checkout', 'mock-checkout-1', { planKey: 'pro' });
  assert.equal(checkout.status, 201);
  const checkoutBody = await checkout.json() as { status: string; checkoutUrl: string };
  assert.equal(checkoutBody.status, 'complete');
  assert.match(checkoutBody.checkoutUrl, /^http:\/\/app\.test\/app\/billing\?checkout=success/);

  let summary = await billingSummary();
  assert.equal(summary.paymentProvider, 'mock');
  assert.equal(summary.subscription.planKey, 'pro');
  assert.equal(summary.subscription.state, 'active');
  assert.equal(summary.subscription.provider, 'mock');
  assert.ok(summary.creditAccount.availableCredits > 1_000);

  const changed = await post('/api/billing/subscription/change', 'mock-change-1', { planKey: 'team' });
  assert.equal(changed.status, 202);
  summary = await billingSummary();
  assert.equal(summary.subscription.planKey, 'team');
  assert.equal(summary.subscription.pendingPlanKey, '');

  const portal = await fetch(`${baseUrl}/api/billing/portal`, {
    method: 'POST',
    headers: authHeaders,
  });
  assert.equal(portal.status, 200);
  assert.deepEqual(await portal.json(), { url: 'http://app.test/app/billing' });

  const canceled = await post('/api/billing/subscription/cancel', 'mock-cancel-1');
  assert.equal(canceled.status, 202);
  summary = await billingSummary();
  assert.equal(summary.subscription.state, 'cancel_at_period_end');
  assert.equal(summary.subscription.cancelAtPeriodEnd, true);
});

function post(path: string, idempotencyKey: string, body?: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      ...authHeaders,
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    },
    body: JSON.stringify(body ?? {}),
  });
}

async function billingSummary(): Promise<{
  paymentProvider: string;
  subscription: { planKey: string; state: string; provider: string; pendingPlanKey: string; cancelAtPeriodEnd: boolean };
  creditAccount: { availableCredits: number };
}> {
  const response = await fetch(`${baseUrl}/api/billing/summary`, { headers: authHeaders });
  assert.equal(response.status, 200);
  return response.json() as Promise<{
    paymentProvider: string;
    subscription: { planKey: string; state: string; provider: string; pendingPlanKey: string; cancelAtPeriodEnd: boolean };
    creditAccount: { availableCredits: number };
  }>;
}
