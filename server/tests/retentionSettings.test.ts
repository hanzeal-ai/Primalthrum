import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { createApp } from '../src/app';
import { SqliteDatabase } from '../src/db/sqlite';
import { createSqliteDatabase } from '../src/db/databaseFactory';
import { hashPassword } from '../src/services/passwordHash';

let root = '';
let dbPath = '';
let server: Server;
let baseUrl = '';
let ownerToken = '';
let developerToken = '';

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'primalthrum-retention-http-'));
  dbPath = join(root, 'platform.sqlite');
  server = createApp({
    dbPath,
    generatedAgentsDir: join(root, 'agents'),
    documentStorageDir: join(root, 'documents'),
    logger: { log: () => undefined },
  }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;

  const setup = await fetch(`${baseUrl}/api/setup/admin`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ email: 'owner@example.com', password: 'correct horse battery staple' }),
  });
  assert.equal(setup.status, 201);
  ownerToken = (await payload<{ session: { token: string } }>(setup)).session.token;

  const db = createSqliteDatabase(dbPath);
  db.run(`
    INSERT INTO users (workspace_id, email, password_hash, role, email_verified_at)
    VALUES (1, 'developer@example.com', '${hashPassword('developer password')}', 'member', CURRENT_TIMESTAMP);
    INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
    VALUES (1, (SELECT id FROM users WHERE email = 'developer@example.com'), 'developer', 'active');
  `);
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ email: 'developer@example.com', password: 'developer password' }),
  });
  assert.equal(login.status, 200);
  developerToken = (await payload<{ session: { token: string } }>(login)).session.token;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

test('retention settings require role, plan entitlement, and password reauthentication', async () => {
  const initial = await fetch(`${baseUrl}/api/settings/retention`, {
    headers: jsonHeaders(ownerToken),
  });
  assert.equal(initial.status, 200);
  const initialState = await payload<RetentionState>(initial);
  assert.equal(initialState.canManage, true);
  assert.equal(initialState.customRetentionEnabled, false);
  assert.equal(initialState.policy.conversationDays, null);

  const freePlanUpdate = await updatePolicy(ownerToken, 'correct horse battery staple');
  assert.equal(freePlanUpdate.status, 403);
  assert.equal((await errorCode(freePlanUpdate)), 'ENTITLEMENT_REQUIRED');

  const db = createSqliteDatabase(dbPath);
  db.run(`
    UPDATE workspace_subscriptions
    SET plan_key = 'business', state = 'active'
    WHERE workspace_id = 1;
  `);

  const wrongPassword = await updatePolicy(ownerToken, 'wrong password');
  assert.equal(wrongPassword.status, 401);
  assert.equal((await errorCode(wrongPassword)), 'REAUTHENTICATION_REQUIRED');

  const updated = await updatePolicy(ownerToken, 'correct horse battery staple');
  assert.equal(updated.status, 200);
  const updatedState = await payload<RetentionState>(updated);
  assert.equal(updatedState.customRetentionEnabled, true);
  assert.equal(updatedState.policy.conversationDays, 90);
  assert.equal(updatedState.policy.runDays, 30);
  assert.equal(updatedState.policy.documentDays, null);
  assert.ok(updatedState.events.some((event) => event.eventType === 'policy_updated'));

  const developerRead = await fetch(`${baseUrl}/api/settings/retention`, {
    headers: jsonHeaders(developerToken),
  });
  assert.equal(developerRead.status, 200);
  assert.equal((await payload<RetentionState>(developerRead)).canManage, false);
  const developerUpdate = await updatePolicy(developerToken, 'developer password');
  assert.equal(developerUpdate.status, 403);
  assert.equal((await errorCode(developerUpdate)), 'AUTHORIZATION_FORBIDDEN');
});

test('manual enforcement is reauthenticated and writes immutable execution evidence', async () => {
  const withoutPassword = await fetch(`${baseUrl}/api/settings/retention/enforce`, {
    method: 'POST',
    headers: jsonHeaders(ownerToken),
    body: JSON.stringify({ password: '' }),
  });
  assert.equal(withoutPassword.status, 401);

  const enforce = await fetch(`${baseUrl}/api/settings/retention/enforce`, {
    method: 'POST',
    headers: jsonHeaders(ownerToken),
    body: JSON.stringify({ password: 'correct horse battery staple' }),
  });
  assert.equal(enforce.status, 200);
  const outcome = await payload<{
    event: { eventType: string; result: Record<string, number> };
    filesDeleted: number;
  }>(enforce);
  assert.equal(outcome.event.eventType, 'enforcement_completed');
  assert.deepEqual(outcome.event.result, {
    conversations: 0,
    runs: 0,
    documents: 0,
    documentBytes: 0,
    filesQueued: 0,
  });
  assert.equal(outcome.filesDeleted, 0);

  const db = createSqliteDatabase(dbPath);
  assert.throws(() => db.run('DELETE FROM retention_events;'), /immutable/);
});

interface RetentionState {
  policy: {
    conversationDays: number | null;
    runDays: number | null;
    documentDays: number | null;
  };
  events: Array<{ eventType: string }>;
  customRetentionEnabled: boolean;
  canManage: boolean;
}

function updatePolicy(token: string, password: string): Promise<Response> {
  return fetch(`${baseUrl}/api/settings/retention`, {
    method: 'PUT',
    headers: jsonHeaders(token),
    body: JSON.stringify({
      conversationDays: 90,
      runDays: 30,
      documentDays: null,
      password,
    }),
  });
}

function jsonHeaders(token = ''): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function errorCode(response: Response): Promise<string> {
  return (await payload<{ error: { code: string } }>(response)).error.code;
}

function payload<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}
