import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Server } from 'node:http';
import { after, before, test } from 'node:test';

import { createApp } from '../src/app';
import { hasWorkspacePermission } from '../src/services/workspaceAuthorization';
import { bootstrapAdminSession } from './authTestHelpers';

let rootDir = '';
let server: Server;
let baseUrl = '';
let authHeaders: Record<string, string> = {};

before(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'primalthrum-billing-api-'));
  const app = createApp({
    dbPath: join(rootDir, 'platform.sqlite'),
    documentStorageDir: join(rootDir, 'documents'),
    generatedAgentsDir: join(rootDir, 'generated-agents'),
    logger: { log: () => undefined },
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;
  authHeaders = await bootstrapAdminSession(baseUrl, 'billing-owner@example.com');
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(rootDir, { recursive: true, force: true });
});

test('public plan catalog is readable without an authenticated session', async () => {
  const response = await fetch(`${baseUrl}/api/public/plans`);
  assert.equal(response.status, 200);
  const plans = await response.json() as Array<{ key: string; entitlements: unknown[] }>;
  assert.deepEqual(plans.map((plan) => plan.key), [
    'free',
    'pro',
    'team',
    'business',
    'enterprise',
  ]);
  assert.ok(plans.every((plan) => Array.isArray(plan.entitlements)));
});

test('workspace billing summary and one-time trial require billing permissions', async () => {
  const unauthorized = await fetch(`${baseUrl}/api/billing/summary`);
  assert.equal(unauthorized.status, 401);
  const freeResponse = await fetch(`${baseUrl}/api/billing/summary`, { headers: authHeaders });
  assert.equal(freeResponse.status, 200);
  const free = await freeResponse.json() as {
    entitlementSnapshot: { planKey: string };
    creditAccount: { availableCredits: number };
  };
  assert.equal(free.entitlementSnapshot.planKey, 'free');
  assert.equal(free.creditAccount.availableCredits, 1000);

  const trialResponse = await fetch(`${baseUrl}/api/billing/trial`, {
    method: 'POST',
    headers: { ...authHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ planKey: 'pro' }),
  });
  assert.equal(trialResponse.status, 201);
  const trial = await trialResponse.json() as {
    entitlementSnapshot: { planKey: string; subscriptionState: string };
    creditAccount: { availableCredits: number };
  };
  assert.equal(trial.entitlementSnapshot.planKey, 'pro');
  assert.equal(trial.entitlementSnapshot.subscriptionState, 'trialing');
  assert.equal(trial.creditAccount.availableCredits, 10000);

  assert.equal(hasWorkspacePermission('owner', 'billing.manage'), true);
  assert.equal(hasWorkspacePermission('admin', 'billing.manage'), false);
  assert.equal(hasWorkspacePermission('billing', 'billing.manage'), true);
  assert.equal(hasWorkspacePermission('billing', 'agents.run'), false);
  assert.equal(hasWorkspacePermission('viewer', 'billing.read'), false);
});

test('billing usage and cost controls expose workspace-scoped commercial limits', async () => {
  const updateResponse = await fetch(`${baseUrl}/api/billing/cost-controls`, {
    method: 'PUT',
    headers: { ...authHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({
      monthlyCreditLimit: 50_000,
      monthlyProviderCostMicrosLimit: 2_000_000,
      hardLimit: true,
      overageEnabled: false,
      alertThresholds: [50, 80, 100],
    }),
  });
  assert.equal(updateResponse.status, 200);
  const controls = await updateResponse.json() as { monthlyCreditLimit: number };
  assert.equal(controls.monthlyCreditLimit, 50_000);

  const usageResponse = await fetch(`${baseUrl}/api/billing/usage`, { headers: authHeaders });
  assert.equal(usageResponse.status, 200);
  const usage = await usageResponse.json() as {
    creditsCharged: number;
    providerCostMicros: number;
    controls: { monthlyProviderCostMicrosLimit: number };
  };
  assert.equal(usage.creditsCharged, 0);
  assert.equal(usage.providerCostMicros, 0);
  assert.equal(usage.controls.monthlyProviderCostMicrosLimit, 2_000_000);

  const alertsResponse = await fetch(`${baseUrl}/api/billing/cost-alerts`, {
    headers: authHeaders,
  });
  assert.equal(alertsResponse.status, 200);
  assert.deepEqual(await alertsResponse.json(), []);
});
