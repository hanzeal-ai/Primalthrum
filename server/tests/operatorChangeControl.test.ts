import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { createApp } from '../src/app';
import { SqliteDatabase } from '../src/db/sqlite';
import { createSqliteDatabase } from '../src/db/databaseFactory';
import { OperatorFeatureFlagRepository } from '../src/services/operatorFeatureFlagRepository';

const BOOTSTRAP_TOKEN = 'operator-change-bootstrap-token-for-test-0001';
const INITIAL_PASSWORD = 'initial operator password';
const CHANGED_PASSWORD = 'changed operator password';

type OperatorRole = 'super_admin' | 'support' | 'billing' | 'security' | 'viewer';

interface OperatorUser {
  id: number;
  email: string;
  role: OperatorRole;
}

let rootDir = '';
let database: SqliteDatabase;
let server: Server;
let baseUrl = '';
const users = new Map<OperatorRole, OperatorUser>();
const tokens = new Map<OperatorRole, string>();

before(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'primalthrum-operator-change-'));
  const dbPath = join(rootDir, 'platform.sqlite');
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

  const setup = await post('/api/operator/setup', {
    email: 'root-change-operator@example.com',
    password: INITIAL_PASSWORD,
  }, { 'x-operator-bootstrap-token': BOOTSTRAP_TOKEN });
  assert.equal(setup.status, 201);
  const root = await setup.json() as { user: OperatorUser; session: { token: string } };
  users.set('super_admin', root.user);
  tokens.set('super_admin', root.session.token);

  for (const role of ['support', 'billing', 'security', 'viewer'] as const) {
    const created = await post('/api/operator/operators', {
      email: `${role}-change-operator@example.com`,
      password: INITIAL_PASSWORD,
      role,
    }, auth(token('super_admin')));
    assert.equal(created.status, 201);
    users.set(role, await created.json() as OperatorUser);
    const login = await post('/api/operator/auth/login', {
      email: `${role}-change-operator@example.com`,
      password: INITIAL_PASSWORD,
    });
    const temporary = await login.json() as { session: { token: string } };
    const changed = await put('/api/operator/auth/password', {
      currentPassword: INITIAL_PASSWORD,
      password: CHANGED_PASSWORD,
    }, auth(temporary.session.token));
    assert.equal(changed.status, 200);
    tokens.set(role, (await changed.json() as { session: { token: string } }).session.token);
  }
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(rootDir, { recursive: true, force: true });
});

test('feature flag reads are universal while mutations are Security-controlled', async () => {
  for (const role of ['super_admin', 'support', 'billing', 'security', 'viewer'] as const) {
    assert.equal((await get('/api/operator/feature-flags', auth(token(role)))).status, 200, role);
  }
  for (const role of ['support', 'billing', 'viewer'] as const) {
    const denied = await post('/api/operator/feature-flags', flagInput(`denied.${role}`), auth(token(role)));
    assert.equal(denied.status, 403, role);
  }
  const securityCreated = await post(
    '/api/operator/feature-flags',
    flagInput('security.controlled'),
    auth(token('security')),
  );
  assert.equal(securityCreated.status, 201);
});

test('legal holds are Security-restricted and require a second operator to release', async () => {
  for (const role of ['support', 'billing', 'viewer'] as const) {
    assert.equal((await get('/api/operator/legal-holds', auth(token(role)))).status, 403, role);
  }
  assert.equal((await get('/api/operator/legal-holds', auth(token('security')))).status, 200);

  const placedResponse = await post('/api/operator/legal-holds', {
    workspaceId: 1,
    externalCaseRef: 'LEGAL-CHANGE-CONTROL-001',
    basis: 'regulatory',
    reason: 'Preserve the approved Workspace records for a regulatory response.',
  }, auth(token('super_admin')));
  assert.equal(placedResponse.status, 201);
  const placed = await placedResponse.json() as {
    id: number;
    revision: number;
    status: string;
    createdByOperatorId: number;
  };
  assert.equal(placed.status, 'active');
  assert.equal(placed.revision, 1);
  assert.equal(placed.createdByOperatorId, user('super_admin').id);

  const selfRelease = await post(`/api/operator/legal-holds/${placed.id}/release`, {
    expectedRevision: placed.revision,
    releaseReason: 'This attempt must be rejected because the maker cannot review itself.',
  }, auth(token('super_admin')));
  assert.equal(selfRelease.status, 409);
  assert.equal((await selfRelease.json() as { error: { code: string } }).error.code,
    'OPERATOR_LEGAL_HOLD_SELF_RELEASE_FORBIDDEN');

  const releasedResponse = await post(`/api/operator/legal-holds/${placed.id}/release`, {
    expectedRevision: placed.revision,
    releaseReason: 'Security independently verified that the preservation obligation ended.',
  }, auth(token('security')));
  assert.equal(releasedResponse.status, 200);
  const released = await releasedResponse.json() as {
    revision: number;
    status: string;
    releasedByOperatorId: number;
  };
  assert.equal(released.status, 'released');
  assert.equal(released.revision, 2);
  assert.equal(released.releasedByOperatorId, user('security').id);

  assert.throws(() => database.run(`DELETE FROM workspace_legal_holds WHERE id = ${placed.id};`),
    /cannot be deleted/);
  assert.throws(() => database.run(`DELETE FROM workspace_legal_hold_events
    WHERE legal_hold_id = ${placed.id};`), /immutable/);
});

test('feature flags enforce rollout, override, kill switch, revision, and immutable history', async () => {
  const createdResponse = await post(
    '/api/operator/feature-flags',
    flagInput('hosted.voice_v2'),
    auth(token('super_admin')),
  );
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json() as {
    id: number;
    revision: number;
    overrides: unknown[];
  };
  assert.equal(created.revision, 1);
  assert.deepEqual(created.overrides, []);

  const repository = new OperatorFeatureFlagRepository(database);
  assert.equal(repository.evaluate('hosted.voice_v2', { workspaceId: 1 }), false);

  const overrideResponse = await post(
    `/api/operator/feature-flags/${created.id}/overrides`,
    {
      workspaceId: 1,
      enabled: true,
      reason: 'Enable the approved pilot Workspace for incident-free validation.',
    },
    auth(token('security')),
  );
  assert.equal(overrideResponse.status, 201);
  const override = await overrideResponse.json() as { id: number; revision: number };
  assert.equal(repository.evaluate('hosted.voice_v2', { workspaceId: 1 }), true);

  const updatedResponse = await put(
    `/api/operator/feature-flags/${created.id}`,
    {
      description: 'Controls the second hosted voice runtime for approved traffic.',
      enabled: true,
      killSwitch: true,
      rolloutPercentage: 100,
      expectedRevision: 1,
    },
    auth(token('security')),
  );
  assert.equal(updatedResponse.status, 200);
  assert.equal((await updatedResponse.json() as { revision: number }).revision, 2);
  assert.equal(repository.evaluate('hosted.voice_v2', { workspaceId: 1 }), false);

  const stale = await put(
    `/api/operator/feature-flags/${created.id}`,
    {
      description: 'Controls the second hosted voice runtime for approved traffic.',
      enabled: true,
      killSwitch: false,
      rolloutPercentage: 100,
      expectedRevision: 1,
    },
    auth(token('super_admin')),
  );
  assert.equal(stale.status, 409);

  const rollout = await put(
    `/api/operator/feature-flags/${created.id}`,
    {
      description: 'Controls the second hosted voice runtime for approved traffic.',
      enabled: true,
      killSwitch: false,
      rolloutPercentage: 50,
      expectedRevision: 2,
    },
    auth(token('security')),
  );
  assert.equal(rollout.status, 200);
  const firstEvaluation = repository.evaluate('hosted.voice_v2', { subjectKey: 'stable-subject' });
  assert.equal(
    repository.evaluate('hosted.voice_v2', { subjectKey: 'stable-subject' }),
    firstEvaluation,
  );
  const rolloutResults = new Set(Array.from({ length: 100 }, (_, index) => (
    repository.evaluate('hosted.voice_v2', { subjectKey: `subject-${index}` })
  )));
  assert.deepEqual([...rolloutResults].sort(), [false, true]);

  const events = await json<Array<{ action: string }>>(
    `/api/operator/feature-flags/${created.id}/events`,
    'viewer',
  );
  assert.deepEqual(events.map((event) => event.action), [
    'updated',
    'updated',
    'override_created',
    'created',
  ]);

  const revoke = await post(
    `/api/operator/feature-flags/${created.id}/overrides/${override.id}/revoke`,
    { expectedRevision: override.revision },
    auth(token('super_admin')),
  );
  assert.equal(revoke.status, 200);
  assert.equal((await revoke.json() as { active: boolean; revision: number }).active, false);
  assert.equal((await post(
    `/api/operator/feature-flags/${created.id}/overrides/${override.id}/revoke`,
    { expectedRevision: override.revision },
    auth(token('super_admin')),
  )).status, 409);

  assert.throws(() => database.run(`DELETE FROM operator_feature_flags WHERE id = ${created.id};`), /cannot be deleted/);
  assert.throws(() => database.run(`DELETE FROM operator_feature_flag_overrides WHERE id = ${override.id};`), /cannot be deleted/);
  assert.throws(() => database.run('UPDATE operator_feature_flag_events SET action = \'updated\' WHERE id = 1;'), /immutable/);
});

test('incidents enforce scope, state transitions, revision, append-only events, and role boundaries', async () => {
  for (const role of ['super_admin', 'support', 'billing', 'security', 'viewer'] as const) {
    assert.equal((await get('/api/operator/incidents', auth(token(role)))).status, 200, role);
  }
  const invalidScope = await post('/api/operator/incidents', {
    ...incidentInput(),
    impactScope: 'platform',
    workspaceId: 1,
  }, auth(token('security')));
  assert.equal(invalidScope.status, 400);
  const future = await post('/api/operator/incidents', {
    ...incidentInput(),
    startedAt: new Date(Date.now() + 60_000).toISOString(),
  }, auth(token('security')));
  assert.equal(future.status, 400);
  assert.equal((await post('/api/operator/incidents', incidentInput(), auth(token('support')))).status, 403);

  const create = await post('/api/operator/incidents', incidentInput(), auth(token('security')));
  assert.equal(create.status, 201);
  let incident = await create.json() as IncidentResponse;
  assert.equal(incident.status, 'investigating');
  assert.equal(incident.revision, 1);
  assert.equal(incident.events[0]?.eventType, 'created');

  const identified = await put(
    `/api/operator/incidents/${incident.id}`,
    incidentUpdate(incident, 'identified'),
    auth(token('security')),
  );
  assert.equal(identified.status, 200);
  incident = await identified.json() as IncidentResponse;
  assert.equal(incident.revision, 2);

  const stale = await put(
    `/api/operator/incidents/${incident.id}`,
    { ...incidentUpdate(incident, 'monitoring'), expectedRevision: 1 },
    auth(token('super_admin')),
  );
  assert.equal(stale.status, 409);

  const event = await post(
    `/api/operator/incidents/${incident.id}/events`,
    { eventType: 'mitigation', message: 'Disabled the affected provider route and verified queue recovery.' },
    auth(token('security')),
  );
  assert.equal(event.status, 201);

  const resolved = await put(
    `/api/operator/incidents/${incident.id}`,
    incidentUpdate(incident, 'resolved'),
    auth(token('security')),
  );
  assert.equal(resolved.status, 200);
  incident = await resolved.json() as IncidentResponse;
  assert.equal(incident.revision, 3);
  assert.ok(incident.resolvedAt);

  const resolvedAt = incident.resolvedAt;
  const editedAfterResolution = await put(
    `/api/operator/incidents/${incident.id}`,
    { ...incidentUpdate(incident, 'resolved'), title: 'Hosted stream latency recovered' },
    auth(token('security')),
  );
  assert.equal(editedAfterResolution.status, 200);
  incident = await editedAfterResolution.json() as IncidentResponse;
  assert.equal(incident.revision, 4);
  assert.equal(incident.resolvedAt, resolvedAt);

  const invalidTransition = await put(
    `/api/operator/incidents/${incident.id}`,
    incidentUpdate(incident, 'monitoring'),
    auth(token('security')),
  );
  assert.equal(invalidTransition.status, 409);

  const reopened = await put(
    `/api/operator/incidents/${incident.id}`,
    incidentUpdate(incident, 'investigating'),
    auth(token('super_admin')),
  );
  assert.equal(reopened.status, 200);
  incident = await reopened.json() as IncidentResponse;
  assert.equal(incident.revision, 5);
  assert.equal(incident.resolvedAt, null);
  assert.ok(incident.events.some((item) => item.eventType === 'mitigation'));
  assert.ok(incident.events.filter((item) => item.eventType === 'status_changed').length >= 3);

  assert.throws(() => database.run(`DELETE FROM operator_incidents WHERE id = ${incident.id};`), /cannot be deleted/);
  assert.throws(() => database.run('DELETE FROM operator_incident_events WHERE id = 1;'), /immutable/);
});

test('change-control mutations produce sanitized immutable Operator audit evidence', async () => {
  const events = await json<Array<{ eventType: string; metadata: Record<string, unknown> }>>(
    '/api/operator/audit?limit=200',
    'security',
  );
  for (const eventType of [
    'operator.feature_flag_created',
    'operator.feature_flag_updated',
    'operator.feature_flag_override_created',
    'operator.feature_flag_override_revoked',
    'operator.incident_created',
    'operator.incident_updated',
    'operator.incident_event_created',
    'operator.legal_hold_placed',
    'operator.legal_hold_released',
  ]) {
    assert.ok(events.some((event) => event.eventType === eventType), eventType);
  }
  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes('Disabled the affected provider route'), false);
  assert.equal(serialized.includes('LEGAL-CHANGE-CONTROL-001'), false);
  assert.equal(serialized.includes('regulatory response'), false);
  assert.throws(() => database.run('DELETE FROM operator_audit_events WHERE id = 1;'), /immutable/);
});

interface IncidentResponse {
  id: number;
  title: string;
  severity: 'sev1' | 'sev2' | 'sev3' | 'sev4';
  status: 'investigating' | 'identified' | 'monitoring' | 'resolved';
  impactScope: 'platform' | 'multi_workspace' | 'workspace';
  workspaceId: number | null;
  summary: string;
  ownerOperatorId: number | null;
  revision: number;
  resolvedAt: string | null;
  events: Array<{ eventType: string }>;
}

function flagInput(key: string) {
  return {
    key,
    description: 'Controls an audited production capability rollout.',
    enabled: true,
    killSwitch: false,
    rolloutPercentage: 0,
  };
}

function incidentInput() {
  return {
    title: 'Hosted stream latency degradation',
    severity: 'sev2',
    impactScope: 'workspace',
    workspaceId: 1,
    summary: 'Elevated hosted stream latency affects an approved test Workspace.',
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    ownerOperatorId: user('security').id,
  };
}

function incidentUpdate(incident: IncidentResponse, status: IncidentResponse['status']) {
  return {
    title: incident.title,
    severity: incident.severity,
    status,
    impactScope: incident.impactScope,
    workspaceId: incident.workspaceId,
    summary: incident.summary,
    ownerOperatorId: incident.ownerOperatorId,
    expectedRevision: incident.revision,
  };
}

function user(role: OperatorRole): OperatorUser {
  const value = users.get(role);
  assert.ok(value, `missing user for ${role}`);
  return value;
}

function token(role: OperatorRole): string {
  const value = tokens.get(role);
  assert.ok(value, `missing token for ${role}`);
  return value;
}

function auth(value: string): Record<string, string> {
  return { authorization: `Bearer ${value}` };
}

function get(path: string, headers: Record<string, string> = {}) {
  return request(path, { headers });
}

function post(path: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return request(path, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function put(path: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return request(path, {
    method: 'PUT',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function json<T>(path: string, role: OperatorRole): Promise<T> {
  const response = await get(path, auth(token(role)));
  assert.equal(response.status, 200);
  return response.json() as Promise<T>;
}

function request(path: string, init?: RequestInit) {
  return fetch(`${baseUrl}${path}`, init);
}
