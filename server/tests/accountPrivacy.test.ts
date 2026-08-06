import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { createApp } from '../src/app';
import { SqliteDatabase, sqlValue } from '../src/db/sqlite';
import { AccountDeletionService } from '../src/services/accountDeletionService';
import { AccountPrivacyRepository } from '../src/services/accountPrivacyRepository';
import { AccountPrivacyScheduler } from '../src/services/accountPrivacyScheduler';
import { LocalDocumentStorage } from '../src/services/fileStorage';
import { hashPassword } from '../src/services/passwordHash';
import { JobRepository } from '../src/services/jobRepository';
import { UserRepository } from '../src/services/userRepository';

const password = 'correct horse battery staple';
let now = new Date('2026-08-06T08:00:00.000Z');
let rootDir = '';
let dbPath = '';
let storageDir = '';
let server: Server;
let baseUrl = '';
let token = '';
let userId = 0;
let workspaceId = 0;
let agentId = 0;
let storageRef = '';

before(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'primalthrum-account-privacy-'));
  dbPath = join(rootDir, 'platform.sqlite');
  storageDir = join(rootDir, 'documents');
  server = createApp({
    accountDeletionGracePeriodMs: 60_000,
    accountPrivacyNow: () => now,
    accountPrivacySchedulerIntervalMs: 60_000,
    dbPath,
    documentStorageDir: storageDir,
    generatedAgentsDir: join(rootDir, 'agents'),
    logger: { log: () => undefined },
  }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;

  const setup = await fetch(`${baseUrl}/api/setup/admin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'privacy-owner@example.com', password }),
  });
  assert.equal(setup.status, 201);
  const setupBody = await setup.json() as {
    user: { id: number; workspaceId: number };
    session: { token: string };
  };
  token = setupBody.session.token;
  userId = setupBody.user.id;
  workspaceId = setupBody.user.workspaceId;

  const agent = await fetch(`${baseUrl}/api/agents`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ name: 'Privacy Export Agent', description: 'portable agent data' }),
  });
  assert.equal(agent.status, 201);
  agentId = (await agent.json() as { id: number }).id;

  const document = await fetch(`${baseUrl}/api/agents/${agentId}/documents/upload`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({
      filename: 'knowledge.txt',
      mimeType: 'text/plain',
      dataBase64: Buffer.from('portable private knowledge').toString('base64'),
    }),
  });
  assert.equal(document.status, 201);
  storageRef = (await document.json() as { storageRef: string }).storageRef;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(rootDir, { recursive: true, force: true });
});

test('account and owner workspace exports require reauthentication and exclude credentials', async () => {
  const rejected = await privacyRequest('/api/settings/privacy/export', 'POST', {
    password: 'wrong password', scope: 'account',
  });
  assert.equal(rejected.status, 401);

  const account = await privacyRequest('/api/settings/privacy/export', 'POST', {
    password, scope: 'account',
  });
  assert.equal(account.status, 200);
  assert.match(account.headers.get('content-disposition') ?? '', /attachment/);
  const accountBody = await account.json() as { scope: string; account: Record<string, unknown> };
  assert.equal(accountBody.scope, 'account');
  assert.equal((accountBody.account.profile as { email: string }).email, 'privacy-owner@example.com');

  const workspace = await privacyRequest('/api/settings/privacy/export', 'POST', {
    password, scope: 'workspace',
  });
  assert.equal(workspace.status, 200);
  const workspaceBody = await workspace.json() as {
    scope: string;
    workspace: { documents: Array<{ content: string }> };
  };
  assert.equal(workspaceBody.scope, 'workspace');
  assert.equal(workspaceBody.workspace.documents[0]?.content, 'portable private knowledge');
  const serialized = JSON.stringify(workspaceBody);
  assert.equal(serialized.includes('password_hash'), false);
  assert.equal(serialized.includes('token_hash'), false);
  assert.equal(serialized.includes('secret_ref'), false);
});

test('account deletion reports shared ownership and paid subscription blockers', async () => {
  const db = new SqliteDatabase(dbPath);
  const member = new UserRepository(db).createUser('privacy-member@example.com', hashPassword(password), true);
  db.run(`
    INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
    VALUES (${sqlValue(workspaceId)}, ${sqlValue(member.id)}, 'member', 'active');
  `);
  const shared = await privacyRequest('/api/settings/privacy/deletion', 'POST', {
    password, confirmEmail: 'privacy-owner@example.com',
  });
  assert.equal(shared.status, 409);
  assert.equal((await shared.json() as { error: { details: { blockers: Array<{ code: string }> } } })
    .error.details.blockers[0]?.code, 'OWNERSHIP_TRANSFER_REQUIRED');

  db.run(`
    UPDATE workspace_memberships SET status = 'inactive' WHERE user_id = ${sqlValue(member.id)};
    UPDATE workspace_subscriptions SET plan_key = 'pro', state = 'active'
    WHERE workspace_id = ${sqlValue(workspaceId)};
  `);
  const paid = await privacyRequest('/api/settings/privacy/deletion', 'POST', {
    password, confirmEmail: 'privacy-owner@example.com',
  });
  assert.equal(paid.status, 409);
  assert.equal((await paid.json() as { error: { details: { blockers: Array<{ code: string }> } } })
    .error.details.blockers[0]?.code, 'ACTIVE_PAID_SUBSCRIPTION');
  db.run(`
    UPDATE workspace_subscriptions SET plan_key = 'free', state = 'active'
    WHERE workspace_id = ${sqlValue(workspaceId)};
    UPDATE workspace_memberships SET status = 'active' WHERE user_id = ${sqlValue(member.id)};
    INSERT INTO operator_users (
      email, password_hash, role, must_change_password, bootstrap_root
    ) VALUES
      ('privacy-legal-maker@example.com', 'unused', 'security', 0, 0),
      ('privacy-legal-reviewer@example.com', 'unused', 'security', 0, 0);
    INSERT INTO workspace_legal_holds (
      hold_ref, workspace_id, external_case_ref, basis, reason, created_by_operator_id
    ) VALUES (
      'LH-PRIVACY-001', ${sqlValue(workspaceId)}, 'PRIVACY-HOLD-001', 'investigation',
      'Preserve all member account records during the authorized investigation.', 1
    );
  `);
  const privacy = new AccountPrivacyRepository(db);
  assert.ok(privacy.deletionBlockers(member.id).some((blocker) => (
    blocker.code === 'LEGAL_HOLD_ACTIVE' && blocker.workspaceId === workspaceId
  )));
  const held = await privacyRequest('/api/settings/privacy/deletion', 'POST', {
    password, confirmEmail: 'privacy-owner@example.com',
  });
  assert.equal(held.status, 409);
  assert.ok((await held.json() as { error: { details: { blockers: Array<{ code: string }> } } })
    .error.details.blockers.some((blocker) => blocker.code === 'LEGAL_HOLD_ACTIVE'));
  db.run(`
    UPDATE workspace_legal_holds
    SET status = 'released', revision = revision + 1, released_by_operator_id = 2,
      release_reason = 'Independent reviewer confirmed the preservation duty ended.',
      released_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE hold_ref = 'LH-PRIVACY-001';
    UPDATE workspace_memberships SET status = 'inactive' WHERE user_id = ${sqlValue(member.id)};
  `);
});

test('scheduled deletion can be cancelled and due execution anonymizes account data', async () => {
  const scheduled = await privacyRequest('/api/settings/privacy/deletion', 'POST', {
    password, confirmEmail: 'privacy-owner@example.com',
  });
  assert.equal(scheduled.status, 202);
  const firstRequest = await scheduled.json() as { requestId: string; status: string };
  assert.equal(firstRequest.status, 'scheduled');

  const cancelled = await privacyRequest('/api/settings/privacy/deletion', 'DELETE', { password });
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json() as { status: string }).status, 'cancelled');

  const rescheduled = await privacyRequest('/api/settings/privacy/deletion', 'POST', {
    password, confirmEmail: 'privacy-owner@example.com',
  });
  assert.equal(rescheduled.status, 202);
  const request = await rescheduled.json() as { requestId: string; scheduledFor: string };
  assert.equal(request.scheduledFor, '2026-08-06T08:01:00.000Z');

  now = new Date('2026-08-06T08:02:00.000Z');
  const db = new SqliteDatabase(dbPath);
  const privacy = new AccountPrivacyRepository(db, () => now);
  const jobs = new JobRepository(db);
  let kicks = 0;
  new AccountPrivacyScheduler(privacy, jobs, () => { kicks += 1; }, 60_000).tick();
  const deletionJob = jobs.nextRunnable(['account.delete']);
  assert.equal(deletionJob?.payload.requestId, request.requestId);
  assert.equal(kicks, 1);
  const deletion = new AccountDeletionService(
    db,
    privacy,
    new LocalDocumentStorage(storageDir),
    () => now,
    60_000,
  );
  const result = await deletion.execute(request.requestId);
  assert.equal(result.status, 'completed');

  const session = await fetch(`${baseUrl}/api/settings/privacy`, { headers: jsonHeaders() });
  assert.equal(session.status, 401);
  const user = db.query<{ email: string; deleted_at: string | null }>(`
    SELECT email, deleted_at FROM users WHERE id = ${sqlValue(userId)};
  `)[0];
  assert.match(user?.email ?? '', /^deleted\+/);
  assert.ok(user?.deleted_at);
  assert.equal(db.query<{ count: number }>(`
    SELECT COUNT(*) AS count FROM agents WHERE workspace_id = ${sqlValue(workspaceId)};
  `)[0]?.count, 0);
  assert.equal(db.query<{ count: number }>(`
    SELECT COUNT(*) AS count FROM workspace_subscriptions WHERE workspace_id = ${sqlValue(workspaceId)};
  `)[0]?.count, 1);
  assert.equal(db.query<{ status: string }>(`
    SELECT status FROM workspace_memberships
    WHERE workspace_id = ${sqlValue(workspaceId)} AND user_id = ${sqlValue(userId)};
  `)[0]?.status, 'inactive');
  assert.equal(existsSync(localPath(storageRef, storageDir)), false);
  assert.equal(privacy.findByRequestId(request.requestId)?.status, 'completed');
  assert.throws(
    () => db.run('DELETE FROM account_privacy_events;'),
    /immutable/,
  );
});

function privacyRequest(path: string, method: string, body?: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: jsonHeaders(),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function jsonHeaders(): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

function localPath(ref: string, root: string): string {
  return join(root, ref.replace('local://documents/', ''));
}
