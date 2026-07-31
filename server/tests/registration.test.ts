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
    exposeAccountEmailPreview: true,
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

test('public registration requires email verification before starting the Pro trial', async () => {
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
    verificationRequired: boolean;
    emailPreviewUrl: string;
    entitlementSnapshot: { planKey: string; subscriptionState: string };
    creditAccount: { availableCredits: number };
  };
  assert.equal(registration.user.email, 'founder@example.com');
  assert.equal(registration.user.role, 'owner');
  assert.equal(registration.user.workspaceId, registration.workspace.id);
  assert.equal(registration.workspace.name, 'Acme Agents');
  assert.equal(registration.verificationRequired, true);
  assert.equal(registration.entitlementSnapshot.subscriptionState, 'active');
  assert.equal(registration.creditAccount.availableCredits, 1000);
  assert.ok(registration.session.token);

  const sessionResponse = await fetch(`${baseUrl}/api/auth/session`, {
    headers: { authorization: `Bearer ${registration.session.token}` },
  });
  assert.equal(sessionResponse.status, 200);
  assert.equal(
    (await sessionResponse.json() as { user: { workspaceId: number }; emailVerified: boolean }).user.workspaceId,
    registration.workspace.id,
  );

  const blocked = await fetch(`${baseUrl}/api/agents`, {
    headers: { authorization: `Bearer ${registration.session.token}` },
  });
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json() as { error: { code: string } }).error.code, 'EMAIL_VERIFICATION_REQUIRED');

  const verificationToken = new URL(registration.emailPreviewUrl).searchParams.get('token');
  assert.ok(verificationToken);
  const verifyResponse = await fetch(`${baseUrl}/api/auth/verify-email`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: verificationToken }),
  });
  assert.equal(verifyResponse.status, 200);
  const verified = await verifyResponse.json() as {
    trial: { planKey: string; creditAmount: number };
    entitlementSnapshot: { subscriptionState: string };
    creditAccount: { availableCredits: number };
  };
  assert.equal(verified.trial.planKey, 'pro');
  assert.equal(verified.trial.creditAmount, 10_000);
  assert.equal(verified.entitlementSnapshot.subscriptionState, 'trialing');
  assert.equal(verified.creditAccount.availableCredits, 10_000);

  const replay = await fetch(`${baseUrl}/api/auth/verify-email`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: verificationToken }),
  });
  assert.equal(replay.status, 400);

  const allowed = await fetch(`${baseUrl}/api/agents`, {
    headers: { authorization: `Bearer ${registration.session.token}` },
  });
  assert.equal(allowed.status, 200);
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
    emailPreviewUrl: string;
    entitlementSnapshot: { planKey: string; subscriptionState: string };
    creditAccount: { availableCredits: number };
  };
  assert.equal(free.entitlementSnapshot.planKey, 'free');
  assert.equal(free.creditAccount.availableCredits, 1000);

  const freeToken = new URL(free.emailPreviewUrl).searchParams.get('token');
  const verifyFree = await fetch(`${baseUrl}/api/auth/verify-email`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: freeToken }),
  });
  assert.equal(verifyFree.status, 200);
  assert.equal((await verifyFree.json() as { trial: null }).trial, null);

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

test('password reset is enumeration-safe, single-use, and revokes old sessions', async () => {
  const forgotUnknown = await fetch(`${baseUrl}/api/auth/password/forgot`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'missing@example.com' }),
  });
  assert.equal(forgotUnknown.status, 202);
  assert.deepEqual(await forgotUnknown.json(), { accepted: true });

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'founder@example.com', password: 'correct horse battery staple' }),
  });
  const oldSession = (await login.json() as { session: { token: string } }).session.token;
  const forgot = await fetch(`${baseUrl}/api/auth/password/forgot`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'founder@example.com' }),
  });
  assert.equal(forgot.status, 202);
  const resetUrl = (await forgot.json() as { emailPreviewUrl: string }).emailPreviewUrl;
  const resetToken = new URL(resetUrl).searchParams.get('token');

  const reset = await fetch(`${baseUrl}/api/auth/password/reset`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: resetToken, password: 'new secure password value' }),
  });
  assert.equal(reset.status, 200);

  const revoked = await fetch(`${baseUrl}/api/auth/session`, {
    headers: { authorization: `Bearer ${oldSession}` },
  });
  assert.equal(revoked.status, 401);
  const oldPassword = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'founder@example.com', password: 'correct horse battery staple' }),
  });
  assert.equal(oldPassword.status, 401);
  const newPassword = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'founder@example.com', password: 'new secure password value' }),
  });
  assert.equal(newPassword.status, 200);

  const replay = await fetch(`${baseUrl}/api/auth/password/reset`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: resetToken, password: 'another secure password' }),
  });
  assert.equal(replay.status, 400);
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
