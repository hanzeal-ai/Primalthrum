import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { createApp } from '../src/app';
import { SqliteDatabase, sqlValue } from '../src/db/sqlite';
import { createSqliteDatabase } from '../src/db/databaseFactory';
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
  database = createSqliteDatabase(dbPath);
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

test('operator domain views enforce RBAC and return minimized operational data', async () => {
  seedOperatorDomainEvidence();
  const endpoints: Array<{
    path: string;
    allowed: OperatorRole[];
  }> = [
    { path: '/api/operator/customer-users', allowed: ['super_admin', 'support', 'security'] },
    { path: '/api/operator/subscriptions', allowed: ['super_admin', 'billing'] },
    { path: '/api/operator/usage', allowed: ['super_admin', 'billing'] },
    { path: '/api/operator/payments', allowed: ['super_admin', 'billing'] },
    { path: '/api/operator/agents', allowed: ['super_admin', 'support', 'security'] },
    { path: '/api/operator/jobs', allowed: ['super_admin', 'support', 'security'] },
    { path: '/api/operator/abuse-events', allowed: ['super_admin', 'security'] },
  ];

  for (const endpoint of endpoints) {
    for (const role of ['super_admin', 'support', 'billing', 'security', 'viewer'] as const) {
      const response = await get(endpoint.path, auth(requireToken(role)));
      assert.equal(
        response.status,
        endpoint.allowed.includes(role) ? 200 : 403,
        `${role} ${endpoint.path}`,
      );
    }
  }

  const customerUsers = await json('/api/operator/customer-users', 'super_admin');
  assert.equal(customerUsers[0].userRef, 'USR-000001');
  assert.equal(customerUsers[0].emailVerified, true);

  const subscriptions = await json('/api/operator/subscriptions?workspaceId=1', 'billing');
  assert.equal(subscriptions[0].planKey, 'free');

  const usage = await json('/api/operator/usage', 'billing');
  assert.equal(usage[0].meter, 'llm.input_tokens');
  assert.equal(usage[0].creditsCharged, 20);

  const payments = await json('/api/operator/payments', 'billing') as unknown as {
    invoices: Array<Record<string, unknown>>;
    refunds: Array<Record<string, unknown>>;
    webhookFailures: Array<Record<string, unknown>>;
  };
  assert.equal(payments.invoices[0]?.amountDueMinor, 2900);
  assert.equal(payments.refunds[0]?.amountMinor, 500);
  assert.equal(payments.webhookFailures[0]?.errorPresent, true);

  const agents = await json('/api/operator/agents', 'support');
  assert.equal(agents[0].agentRef, 'AGT-000001');
  const jobs = await json('/api/operator/jobs', 'security');
  assert.equal(jobs[0].hasError, true);
  const abuse = await json('/api/operator/abuse-events', 'security');
  assert.equal(abuse[0].ruleKey, 'auth.login');

  const serialized = JSON.stringify({ customerUsers, subscriptions, usage, payments, agents, jobs, abuse });
  for (const sensitive of [
    'workspace-owner@example.com',
    'customer-password-hash',
    'provider-customer-sensitive',
    'provider-subscription-sensitive',
    'provider-invoice-sensitive',
    'provider-refund-sensitive',
    'hosted-invoice-sensitive',
    'webhook-payload-sensitive',
    'webhook-error-sensitive',
    'agent-source-path-sensitive',
    'Operator test Agent',
    'operator-test-agent',
    'agent-config-sensitive',
    'job-payload-sensitive',
    'job-result-sensitive',
    'job-error-sensitive',
    'abuse-subject-sensitive',
    'abuse-metadata-sensitive',
  ]) {
    assert.equal(serialized.includes(sensitive), false, sensitive);
  }

  assert.equal((await get(
    '/api/operator/agents?workspaceId=invalid',
    auth(superToken),
  )).status, 400);
  assert.deepEqual(await json('/api/operator/agents?workspaceId=9999', 'super_admin'), []);
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

async function json(path: string, role: OperatorRole): Promise<Array<Record<string, unknown>>> {
  const response = await get(path, auth(requireToken(role)));
  assert.equal(response.status, 200);
  return response.json() as Promise<Array<Record<string, unknown>>>;
}

function seedOperatorDomainEvidence(): void {
  const meterPrice = database.query<{ id: number }>(`
    SELECT id FROM meter_prices WHERE meter = 'llm.input_tokens' LIMIT 1;
  `)[0];
  assert.ok(meterPrice);
  database.run(`
    UPDATE users SET password_hash = 'customer-password-hash' WHERE id = 1;
    INSERT INTO agents (workspace_id, name, slug, description, path, status)
    VALUES (1, 'Operator test Agent', 'operator-test-agent', '',
      'agent-source-path-sensitive', 'published');
    INSERT INTO agent_configs (agent_id, config_json)
    VALUES (last_insert_rowid(), '{"secret":"agent-config-sensitive"}');
    INSERT INTO jobs (
      workspace_id, type, status, attempts, max_attempts,
      payload_json, result_json, error
    ) VALUES (
      1, 'agent.validation', 'failed', 3, 3,
      '{"secret":"job-payload-sensitive"}',
      '{"secret":"job-result-sensitive"}',
      'job-error-sensitive'
    );
    INSERT INTO rated_usage_events (
      workspace_id, idempotency_key, meter, provider, model, quantity,
      billable_units, credits_charged, provider_cost_micros, meter_price_id,
      resource_type, resource_id, metadata_json, occurred_at
    ) VALUES (
      1, 'operator-usage-test', 'llm.input_tokens', 'mock', 'mock-model', 2000,
      2, 20, 3000, ${sqlValue(meterPrice.id)}, 'run', '1', '{}', CURRENT_TIMESTAMP
    );
    INSERT INTO billing_invoices (
      workspace_id, provider, provider_invoice_ref, provider_customer_ref,
      provider_subscription_ref, status, currency, amount_due_minor,
      amount_paid_minor, hosted_invoice_url, invoice_pdf_url
    ) VALUES (
      1, 'stripe', 'provider-invoice-sensitive', 'provider-customer-sensitive',
      'provider-subscription-sensitive', 'open', 'usd', 2900, 0,
      'hosted-invoice-sensitive', 'invoice-pdf-sensitive'
    );
    INSERT INTO billing_refunds (
      workspace_id, provider, provider_refund_ref, provider_payment_ref,
      provider_invoice_ref, status, amount_minor, currency, reason
    ) VALUES (
      1, 'stripe', 'provider-refund-sensitive', 'provider-payment-sensitive',
      'provider-invoice-sensitive', 'succeeded', 500, 'usd', 'private-reason-sensitive'
    );
    INSERT INTO payment_webhook_events (
      provider, provider_event_ref, event_type, payload_json,
      workspace_id, status, error
    ) VALUES (
      'stripe', 'provider-event-sensitive', 'invoice.payment_failed',
      '{"secret":"webhook-payload-sensitive"}', 1, 'failed', 'webhook-error-sensitive'
    );
    INSERT INTO abuse_enforcement_events (
      event_id, rule_key, action, subject_hash, outcome,
      retry_after_seconds, metadata_json
    ) VALUES (
      'abuse-event-operator-test', 'auth.login', 'rate_limit',
      'abuse-subject-sensitive', 'rate_limited', 60,
      '{"secret":"abuse-metadata-sensitive"}'
    );
  `);
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
