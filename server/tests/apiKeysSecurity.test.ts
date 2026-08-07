import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { createApp } from '../src/app';
import { SqliteDatabase } from '../src/db/sqlite';
import { createSqliteDatabase } from '../src/db/databaseFactory';

let rootDir = '';
let dbPath = '';
let server: Server;
let baseUrl = '';
let ownerToken = '';
let workspaceId = 0;

before(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'primalthrum-api-keys-'));
  dbPath = join(rootDir, 'platform.sqlite');
  server = createApp({
    dbPath,
    generatedAgentsDir: join(rootDir, 'agents'),
    documentStorageDir: join(rootDir, 'documents'),
    logger: { log: () => undefined },
  }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;

  const setup = await fetch(`${baseUrl}/api/setup/admin`, {
    method: 'POST', headers: jsonHeaders(),
    body: JSON.stringify({ email: 'security-owner@example.com', password: 'correct horse battery staple' }),
  });
  assert.equal(setup.status, 201);
  const payload = await body<{ user: { workspaceId: number }; session: { token: string } }>(setup);
  ownerToken = payload.session.token;
  workspaceId = payload.user.workspaceId;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(rootDir, { recursive: true, force: true });
});

test('workspace API keys are scoped, hashed, audited, tenant-bound, and revocable', async () => {
  const agent = await fetch(`${baseUrl}/api/agents`, {
    method: 'POST', headers: jsonHeaders(ownerToken), body: JSON.stringify({ name: 'Default Agent' }),
  });
  assert.equal(agent.status, 201);

  const withoutPassword = await createKey('wrong password');
  assert.equal(withoutPassword.status, 401);

  const create = await createKey('correct horse battery staple');
  assert.equal(create.status, 201);
  const created = await body<{
    id: number; token: string; keyPrefix: string; scopes: string[]; expiresAt: string;
  }>(create);
  assert.match(created.token, /^ptk_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+$/);
  assert.ok(created.expiresAt);
  assert.deepEqual(created.scopes, ['agents:read', 'agents:run']);

  const listed = await fetch(`${baseUrl}/api/settings/api-keys`, {
    headers: jsonHeaders(ownerToken),
  });
  assert.equal(listed.status, 200);
  const listedKeys = await body<Array<Record<string, unknown>>>(listed);
  assert.equal(listedKeys.length, 1);
  assert.equal(listedKeys[0]?.keyPrefix, created.keyPrefix);
  assert.equal('token' in (listedKeys[0] ?? {}), false);

  const keyAgents = await fetch(`${baseUrl}/api/agents`, { headers: jsonHeaders(created.token) });
  assert.equal(keyAgents.status, 200);
  assert.deepEqual((await body<Array<{ name: string }>>(keyAgents)).map((item) => item.name), ['Default Agent']);

  const forbiddenWrite = await fetch(`${baseUrl}/api/agents`, {
    method: 'POST', headers: jsonHeaders(created.token), body: JSON.stringify({ name: 'Forbidden' }),
  });
  assert.equal(forbiddenWrite.status, 403);
  assert.equal((await body<{ error: { code: string } }>(forbiddenWrite)).error.code, 'API_KEY_SCOPE_FORBIDDEN');

  const forbiddenSettings = await fetch(`${baseUrl}/api/settings/api-keys`, {
    headers: jsonHeaders(created.token),
  });
  assert.equal(forbiddenSettings.status, 403);

  const secondWorkspace = await fetch(`${baseUrl}/api/workspaces`, {
    method: 'POST', headers: jsonHeaders(ownerToken), body: JSON.stringify({ name: 'Second Workspace' }),
  });
  assert.equal(secondWorkspace.status, 201);
  const secondAgent = await fetch(`${baseUrl}/api/agents`, {
    method: 'POST', headers: jsonHeaders(ownerToken), body: JSON.stringify({ name: 'Second Agent' }),
  });
  assert.equal(secondAgent.status, 201);
  const stillScoped = await fetch(`${baseUrl}/api/agents`, { headers: jsonHeaders(created.token) });
  assert.deepEqual((await body<Array<{ name: string }>>(stillScoped)).map((item) => item.name), ['Default Agent']);

  const db = createSqliteDatabase(dbPath);
  const stored = db.query<{ token_hash: string }>(`
    SELECT token_hash FROM workspace_api_keys WHERE id = ${created.id};
  `);
  assert.equal(stored.length, 1);
  assert.notEqual(stored[0]?.token_hash, created.token);
  assert.doesNotMatch(JSON.stringify(stored), new RegExp(created.token));
  assert.equal(db.query<{ count: number }>(`
    SELECT COUNT(*) AS count FROM api_key_usage_events WHERE api_key_id = ${created.id};
  `)[0]?.count, 3);

  const switchBack = await fetch(`${baseUrl}/api/auth/workspace`, {
    method: 'POST', headers: jsonHeaders(ownerToken), body: JSON.stringify({ workspaceId }),
  });
  assert.equal(switchBack.status, 200);
  const revoke = await fetch(`${baseUrl}/api/settings/api-keys/${created.id}`, {
    method: 'DELETE', headers: jsonHeaders(ownerToken),
  });
  assert.equal(revoke.status, 204);
  assert.equal((await fetch(`${baseUrl}/api/agents`, { headers: jsonHeaders(created.token) })).status, 401);
});

test('users can inspect sessions and revoke every other session', async () => {
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: jsonHeaders(),
    body: JSON.stringify({ email: 'security-owner@example.com', password: 'correct horse battery staple' }),
  });
  assert.equal(login.status, 200);
  const secondToken = (await body<{ session: { token: string } }>(login)).session.token;

  const sessions = await fetch(`${baseUrl}/api/settings/sessions`, {
    headers: jsonHeaders(ownerToken),
  });
  assert.equal(sessions.status, 200);
  const records = await body<Array<{ id: number; current: boolean }>>(sessions);
  assert.equal(records.filter((record) => record.current).length, 1);
  assert.ok(records.length >= 2);

  const current = records.find((record) => record.current);
  assert(current);
  const currentRevoke = await fetch(`${baseUrl}/api/settings/sessions/${current.id}`, {
    method: 'DELETE', headers: jsonHeaders(ownerToken),
  });
  assert.equal(currentRevoke.status, 400);

  const revokeOthers = await fetch(`${baseUrl}/api/settings/sessions/revoke-others`, {
    method: 'POST', headers: jsonHeaders(ownerToken),
  });
  assert.equal(revokeOthers.status, 200);
  assert.ok((await body<{ revoked: number }>(revokeOthers)).revoked >= 1);
  assert.equal((await fetch(`${baseUrl}/api/auth/session`, { headers: jsonHeaders(secondToken) })).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/auth/session`, { headers: jsonHeaders(ownerToken) })).status, 200);
});

function createKey(password: string): Promise<Response> {
  return fetch(`${baseUrl}/api/settings/api-keys`, {
    method: 'POST',
    headers: jsonHeaders(ownerToken),
    body: JSON.stringify({
      name: 'Production integration',
      scopes: ['agents:read', 'agents:run'],
      expiresInDays: 90,
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

function body<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}
