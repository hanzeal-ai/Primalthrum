import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { createApp } from '../src/app';

let rootDir = '';
let server: Server;
let baseUrl = '';

before(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'primalthrum-registration-'));
  server = createApp({
    dbPath: join(rootDir, 'platform.sqlite'),
    documentStorageDir: join(rootDir, 'documents'),
    generatedAgentsDir: join(rootDir, 'generated-agents'),
    logger: { log: () => undefined },
  }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(rootDir, { recursive: true, force: true });
});

test('public registration creates an isolated owner workspace and Pro trial', async () => {
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'founder@example.com',
      password: 'correct horse battery staple',
      workspaceName: 'Acme Agents',
      planKey: 'pro',
    }),
  });
  assert.equal(response.status, 201);
  const registration = await response.json() as {
    user: { workspaceId: number; role: string; email: string };
    session: { token: string };
    workspace: { id: number; name: string };
    trial: { planKey: string; creditAmount: number };
    entitlementSnapshot: { planKey: string; subscriptionState: string };
    creditAccount: { availableCredits: number };
  };
  assert.equal(registration.user.email, 'founder@example.com');
  assert.equal(registration.user.role, 'owner');
  assert.equal(registration.user.workspaceId, registration.workspace.id);
  assert.equal(registration.workspace.name, 'Acme Agents');
  assert.equal(registration.trial.planKey, 'pro');
  assert.equal(registration.trial.creditAmount, 10_000);
  assert.equal(registration.entitlementSnapshot.subscriptionState, 'trialing');
  assert.equal(registration.creditAccount.availableCredits, 10_000);
  assert.ok(registration.session.token);

  const sessionResponse = await fetch(`${baseUrl}/api/auth/session`, {
    headers: { authorization: `Bearer ${registration.session.token}` },
  });
  assert.equal(sessionResponse.status, 200);
  assert.equal(
    (await sessionResponse.json() as { user: { workspaceId: number } }).user.workspaceId,
    registration.workspace.id,
  );
});

test('registration supports a free account and rejects duplicate email', async () => {
  const freeInput = {
    email: 'free@example.com',
    password: 'another secure password',
    workspaceName: 'Free Workspace',
    planKey: 'free',
  };
  const freeResponse = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(freeInput),
  });
  assert.equal(freeResponse.status, 201);
  const free = await freeResponse.json() as {
    trial: null;
    entitlementSnapshot: { planKey: string; subscriptionState: string };
    creditAccount: { availableCredits: number };
  };
  assert.equal(free.trial, null);
  assert.equal(free.entitlementSnapshot.planKey, 'free');
  assert.equal(free.creditAccount.availableCredits, 1000);

  const duplicateResponse = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(freeInput),
  });
  assert.equal(duplicateResponse.status, 409);
  assert.equal(
    (await duplicateResponse.json() as { error: { code: string } }).error.code,
    'ACCOUNT_ALREADY_EXISTS',
  );
});

test('registration rejects invalid plans before creating an account', async () => {
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'invalid-plan@example.com',
      password: 'another secure password',
      workspaceName: 'Invalid Plan',
      planKey: 'enterprise',
    }),
  });
  assert.equal(response.status, 400);

  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'invalid-plan@example.com',
      password: 'another secure password',
    }),
  });
  assert.equal(loginResponse.status, 401);
});
