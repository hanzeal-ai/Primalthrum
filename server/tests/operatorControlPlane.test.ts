import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { createApp } from '../src/app';
import { SqliteDatabase, sqlValue } from '../src/db/sqlite';
import { OperatorAuditRepository } from '../src/services/operatorAuditRepository';
import { bootstrapAdminSession } from './authTestHelpers';

const BOOTSTRAP_TOKEN = 'operator-bootstrap-token-for-test-only-0001';
const INITIAL_PASSWORD = 'initial operator password';
const CHANGED_PASSWORD = 'changed operator password';

type OperatorRole = 'super_admin' | 'support' | 'billing' | 'security' | 'viewer';

interface OperatorUser {
  id: number;
  email: string;
  role: OperatorRole;
  mustChangePassword: boolean;
}

let rootDir = '';
let dbPath = '';
let database: SqliteDatabase;
let server: Server;
let baseUrl = '';
let customerHeaders: Record<string, string> = {};
let superUser: OperatorUser;
let superToken = '';
const operatorUsers = new Map<OperatorRole, OperatorUser>();
const operatorTokens = new Map<OperatorRole, string>();

before(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'primalthrum-operator-'));
  dbPath = join(rootDir, 'platform.sqlite');
  database = new SqliteDatabase(dbPath);
  server = createApp({
    dbPath,
    documentStorageDir: join(rootDir, 'documents'),
    generatedAgentsDir: join(rootDir, 'generated-agents'),
    logger: { log: () => undefined },
    operatorBootstrapToken: BOOTSTRAP_TOKEN,
  }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;
  customerHeaders = await bootstrapAdminSession(baseUrl, 'workspace-owner@example.com');
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(rootDir, { recursive: true, force: true });
});

test('operator bootstrap is token-bound, one-time, and separate from customer auth', async () => {
  const status = await get('/api/operator/setup/status');
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { needsSetup: true, setupEnabled: true });

  const forbidden = await post('/api/operator/setup', {
    email: 'root-operator@example.com',
    password: INITIAL_PASSWORD,
  }, { 'x-operator-bootstrap-token': 'wrong-bootstrap-token-value-000000' });
  assert.equal(forbidden.status, 403);

  const setup = await post('/api/operator/setup', {
    email: 'root-operator@example.com',
    password: INITIAL_PASSWORD,
  }, { 'x-operator-bootstrap-token': BOOTSTRAP_TOKEN });
  assert.equal(setup.status, 201);
  const created = await setup.json() as {
    user: OperatorUser;
    session: { token: string };
  };
  superUser = created.user;
  superToken = created.session.token;
  operatorUsers.set('super_admin', superUser);
  operatorTokens.set('super_admin', superToken);
  assert.equal(superUser.role, 'super_admin');
  assert.equal(superUser.mustChangePassword, false);

  assert.throws(() => database.run(`
    INSERT INTO operator_users (
      email, password_hash, role, must_change_password, bootstrap_root
    ) VALUES (
      'second-root@example.com', 'invalid-hash', 'super_admin', 0, 1
    );
  `), /UNIQUE constraint failed/);

  const replay = await post('/api/operator/setup', {
    email: 'another-root@example.com',
    password: INITIAL_PASSWORD,
  }, { 'x-operator-bootstrap-token': BOOTSTRAP_TOKEN });
  assert.equal(replay.status, 409);

  const customerDenied = await get('/api/operator/overview', customerHeaders);
  assert.equal(customerDenied.status, 401);
  const operatorDenied = await get('/api/agents', auth(superToken));
  assert.equal(operatorDenied.status, 401);

  const stored = database.query<{ token_hash: string }>(`
    SELECT token_hash FROM operator_sessions WHERE operator_user_id = ${sqlValue(superUser.id)};
  `)[0];
  assert.equal(stored?.token_hash, createHash('sha256').update(superToken).digest('hex'));
  assert.notEqual(stored?.token_hash, superToken);
});

test('super admin provisions every operator role with forced password rotation', async () => {
  for (const role of ['support', 'billing', 'security', 'viewer'] as const) {
    const create = await post('/api/operator/operators', {
      email: `${role}-operator@example.com`,
      password: INITIAL_PASSWORD,
      role,
    }, auth(superToken));
    assert.equal(create.status, 201);
    const user = await create.json() as OperatorUser;
    assert.equal(user.role, role);
    assert.equal(user.mustChangePassword, true);
    operatorUsers.set(role, user);

    const login = await post('/api/operator/auth/login', {
      email: user.email,
      password: INITIAL_PASSWORD,
    });
    assert.equal(login.status, 200);
    const temporary = await login.json() as { session: { token: string } };
    const blocked = await get('/api/operator/overview', auth(temporary.session.token));
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json() as { error: { code: string } }).error.code, 'OPERATOR_PASSWORD_CHANGE_REQUIRED');

    const change = await put('/api/operator/auth/password', {
      currentPassword: INITIAL_PASSWORD,
      password: CHANGED_PASSWORD,
    }, auth(temporary.session.token));
    assert.equal(change.status, 200);
    const changed = await change.json() as {
      user: OperatorUser;
      session: { token: string };
    };
    assert.equal(changed.user.mustChangePassword, false);
    operatorTokens.set(role, changed.session.token);

    assert.equal((await get('/api/operator/overview', auth(temporary.session.token))).status, 401);
    assert.equal((await get('/api/operator/overview', auth(changed.session.token))).status, 200);
  }

  const wrongPassword = await post('/api/operator/auth/login', {
    email: 'support-operator@example.com',
    password: 'not the correct password',
  });
  assert.equal(wrongPassword.status, 401);
});

test('operator RBAC restricts support, billing, security, and viewer duties', async () => {
  const matrix: Array<{
    role: OperatorRole;
    audit: number;
    operators: number;
    support: number;
  }> = [
    { role: 'super_admin', audit: 200, operators: 200, support: 200 },
    { role: 'support', audit: 403, operators: 200, support: 200 },
    { role: 'billing', audit: 403, operators: 403, support: 403 },
    { role: 'security', audit: 200, operators: 200, support: 200 },
    { role: 'viewer', audit: 403, operators: 403, support: 403 },
  ];
  for (const expected of matrix) {
    const headers = auth(requireToken(expected.role));
    assert.equal((await get('/api/operator/overview', headers)).status, 200, expected.role);
    assert.equal((await get('/api/operator/workspaces', headers)).status, 200, expected.role);
    assert.equal((await get('/api/operator/audit', headers)).status, expected.audit, expected.role);
    assert.equal((await get('/api/operator/operators', headers)).status, expected.operators, expected.role);
    assert.equal((await get('/api/operator/support-grants', headers)).status, expected.support, expected.role);
  }

  const overview = await get('/api/operator/overview', auth(superToken));
  const payload = await overview.json() as {
    overview: { workspaces: number; users: number; activeSubscriptions: number };
    readiness: { status: string };
  };
  assert.equal(payload.overview.workspaces, 1);
  assert.equal(payload.overview.users, 1);
  assert.equal(payload.overview.activeSubscriptions, 1);
  assert.ok(['ready', 'not_ready'].includes(payload.readiness.status));
});

test('support access is assigned, scoped, time-limited, revocable, and audited', async () => {
  const supportUser = requireUser('support');
  const tooLong = await post('/api/operator/support-grants', {
    workspaceId: 1,
    operatorUserId: supportUser.id,
    permissions: ['workspace.metadata.read'],
    reason: 'Investigate an authenticated customer incident.',
    ticketRef: 'SUP-1001',
    expiresAt: new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString(),
  }, auth(superToken));
  assert.equal(tooLong.status, 400);

  const invalidTarget = await post('/api/operator/support-grants', {
    workspaceId: 1,
    operatorUserId: requireUser('billing').id,
    permissions: ['workspace.metadata.read'],
    reason: 'Investigate an authenticated customer incident.',
    ticketRef: 'SUP-1002',
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  }, auth(superToken));
  assert.equal(invalidTarget.status, 400);

  const create = await post('/api/operator/support-grants', {
    workspaceId: 1,
    operatorUserId: supportUser.id,
    permissions: ['workspace.metadata.read', 'workspace.agents.read'],
    reason: 'Investigate an authenticated customer incident.',
    ticketRef: 'SUP-1003',
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  }, auth(superToken));
  assert.equal(create.status, 201);
  const grant = await create.json() as { id: number; status: string };
  assert.equal(grant.status, 'active');

  const unassigned = await get(
    `/api/operator/support-grants/${grant.id}/context`,
    auth(superToken),
  );
  assert.equal(unassigned.status, 403);

  const contextResponse = await get(
    `/api/operator/support-grants/${grant.id}/context`,
    auth(requireToken('support')),
  );
  assert.equal(contextResponse.status, 200);
  const context = await contextResponse.json() as {
    context: Record<string, unknown>;
  };
  assert.ok(context.context.workspace);
  assert.ok(context.context.agents);
  assert.equal('billing' in context.context, false);
  const serialized = JSON.stringify(context).toLowerCase();
  for (const sensitive of ['password_hash', 'token_hash', 'secret_ref', 'payload_json', 'email']) {
    assert.equal(serialized.includes(sensitive), false, sensitive);
  }

  const revoke = await request(`/api/operator/support-grants/${grant.id}`, {
    method: 'DELETE',
    headers: auth(requireToken('security')),
  });
  assert.equal(revoke.status, 200);
  assert.equal((await revoke.json() as { status: string }).status, 'revoked');
  assert.equal((await get(
    `/api/operator/support-grants/${grant.id}/context`,
    auth(requireToken('support')),
  )).status, 403);

  assert.throws(() => database.run(`
    UPDATE operator_support_grants
    SET reason = 'tampered support reason'
    WHERE id = ${sqlValue(grant.id)};
  `), /immutable/);

  database.run(`
    INSERT INTO operator_support_grants (
      workspace_id, operator_user_id, permissions_json, reason,
      ticket_ref, expires_at, created_by_operator_id
    ) VALUES (
      1, ${sqlValue(supportUser.id)},
      '["workspace.metadata.read","workspace.billing.read"]',
      'Inspect billing state for an approved support ticket.',
      'SUP-1004', '2000-01-01T00:00:00.000Z', ${sqlValue(superUser.id)}
    );
  `);
  const expiringGrant = database.query<{ id: number }>(`
    SELECT id FROM operator_support_grants WHERE ticket_ref = 'SUP-1004';
  `)[0];
  assert.ok(expiringGrant);
  assert.equal((await get(
    `/api/operator/support-grants/${expiringGrant.id}/context`,
    auth(requireToken('support')),
  )).status, 403);
});

test('operator audit records are immutable and remove sensitive metadata', async () => {
  new OperatorAuditRepository(database).record({
    operatorUserId: superUser.id,
    eventType: 'operator.sensitive_test',
    targetType: 'operator',
    targetId: superUser.id,
    metadata: {
      password: 'must-not-persist',
      accessToken: 'must-not-persist',
      safe: 'kept',
      nested: { secret: 'must-not-persist', reason: 'approved' },
    },
  });
  const response = await get('/api/operator/audit?limit=200', auth(superToken));
  assert.equal(response.status, 200);
  const events = await response.json() as Array<{
    eventType: string;
    metadata: Record<string, unknown>;
  }>;
  const sensitive = events.find((event) => event.eventType === 'operator.sensitive_test');
  assert.deepEqual(sensitive?.metadata, { safe: 'kept', nested: { reason: 'approved' } });
  const failedLogin = events.find((event) => event.eventType === 'operator.login_failed');
  assert.deepEqual(failedLogin?.metadata, { identityProvided: true });
  assert.ok(events.some((event) => event.eventType === 'operator.support_grant_created'));
  assert.ok(events.some((event) => event.eventType === 'operator.support_context_read'));
  assert.ok(events.some((event) => event.eventType === 'operator.support_grant_revoked'));

  assert.throws(() => database.run(`
    UPDATE operator_audit_events SET event_type = 'tampered' WHERE id = 1;
  `), /immutable/);
  assert.throws(() => database.run('DELETE FROM operator_audit_events WHERE id = 1;'), /immutable/);
});

function requireToken(role: OperatorRole): string {
  const token = operatorTokens.get(role);
  assert.ok(token, `missing token for ${role}`);
  return token;
}

function requireUser(role: OperatorRole): OperatorUser {
  const user = operatorUsers.get(role);
  assert.ok(user, `missing user for ${role}`);
  return user;
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function get(path: string, headers: Record<string, string> = {}) {
  return request(path, { headers });
}

function post(
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return request(path, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function put(
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return request(path, {
    method: 'PUT',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function request(path: string, init?: RequestInit) {
  return fetch(`${baseUrl}${path}`, init);
}
