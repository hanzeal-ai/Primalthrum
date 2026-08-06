import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { createApp } from '../src/app';
import { SqliteDatabase } from '../src/db/sqlite';
import { type AccountEmailMessage } from '../src/services/accountEmailSender';
import { BillingRepository } from '../src/services/billingRepository';
import { hashPassword } from '../src/services/passwordHash';
import { UserRepository } from '../src/services/userRepository';

let rootDir = '';
let dbPath = '';
let server: Server;
let baseUrl = '';
let ownerToken = '';
let ownerUserId = 0;
let workspaceId = 0;
const deliveredEmails: AccountEmailMessage[] = [];

before(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'primalthrum-workspace-team-'));
  dbPath = join(rootDir, 'platform.sqlite');
  server = createApp({
    dbPath,
    generatedAgentsDir: join(rootDir, 'agents'),
    documentStorageDir: join(rootDir, 'documents'),
    accountEmailSender: {
      send: async (message) => {
        deliveredEmails.push(message);
        return { provider: 'test', providerMessageId: `workspace-invitation-${message.id}` };
      },
    },
    logger: { log: () => undefined },
  }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;

  const setup = await fetch(`${baseUrl}/api/setup/admin`, {
    method: 'POST', headers: jsonHeaders(),
    body: JSON.stringify({ email: 'team-owner@example.com', password: 'correct horse battery staple' }),
  });
  assert.equal(setup.status, 201);
  const payload = await body<{ user: { id: number; workspaceId: number }; session: { token: string } }>(setup);
  ownerToken = payload.session.token;
  ownerUserId = payload.user.id;
  workspaceId = payload.user.workspaceId;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(rootDir, { recursive: true, force: true });
});

test('workspace invitations reserve seats, reject existing members, and can be revoked', async () => {
  const selfRoleChange = await fetch(
    `${baseUrl}/api/workspaces/${workspaceId}/members/${ownerUserId}`,
    { method: 'PATCH', headers: jsonHeaders(ownerToken), body: JSON.stringify({ role: 'admin' }) },
  );
  assert.equal(selfRoleChange.status, 400);
  assert.match((await body<{ error: { message: string } }>(selfRoleChange)).error.message, /own workspace role/);

  const selfRemoval = await fetch(
    `${baseUrl}/api/workspaces/${workspaceId}/members/${ownerUserId}`,
    { method: 'DELETE', headers: jsonHeaders(ownerToken) },
  );
  assert.equal(selfRemoval.status, 400);
  assert.match((await body<{ error: { message: string } }>(selfRemoval)).error.message, /remove yourself/);

  const freeInvite = await createInvite('first@example.com', 'viewer');
  assert.equal(freeInvite.status, 403);
  assert.equal((await body<{ error: { code: string } }>(freeInvite)).error.code, 'ENTITLEMENT_LIMIT_EXCEEDED');

  new BillingRepository(new SqliteDatabase(dbPath)).grantEntitlement({
    workspaceId,
    feature: 'seats',
    enabled: true,
    quantityLimit: 2,
    sourceType: 'test',
    sourceRef: 'workspace-team',
  });

  const ownerInvite = await createInvite('team-owner@example.com', 'admin');
  assert.equal(ownerInvite.status, 400);

  const first = await createInvite('first@example.com', 'viewer');
  assert.equal(first.status, 201);
  const created = await body<{ id: number; token: string; emailDelivery: string }>(first);
  assert.ok(created.token);
  assert.equal(created.emailDelivery, 'queued');
  await waitFor(() => deliveredEmails.some((message) => message.recipientEmail === 'first@example.com'));
  const invitationEmail = deliveredEmails.find((message) => message.recipientEmail === 'first@example.com');
  assert.equal(invitationEmail?.template, 'workspace_invitation');
  assert.equal(invitationEmail?.payload.workspaceName, 'Local Workspace');
  assert.equal(invitationEmail?.payload.role, 'viewer');
  assert.match(String(invitationEmail?.payload.actionUrl), /accept-invitation\?token=/);

  const overLimit = await createInvite('second@example.com', 'member');
  assert.equal(overLimit.status, 403);

  const revoke = await fetch(
    `${baseUrl}/api/workspaces/${workspaceId}/invitations/${created.id}`,
    { method: 'DELETE', headers: jsonHeaders(ownerToken) },
  );
  assert.equal(revoke.status, 204);
  const revokedAccept = await acceptInvite(created.token, 'new member password');
  assert.equal(revokedAccept.status, 400);

  const replacement = await createInvite('second@example.com', 'developer');
  assert.equal(replacement.status, 201);
  const replacementInvite = await body<{ token: string }>(replacement);
  const accepted = await acceptInvite(replacementInvite.token, 'new member password');
  assert.equal(accepted.status, 201);
  const acceptedBody = await body<{
    user: { id: number; role: string };
    session: { token: string };
  }>(accepted);
  assert.equal(acceptedBody.user.role, 'developer');

  const duplicate = await createInvite('second@example.com', 'viewer');
  assert.equal(duplicate.status, 400);

  const members = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/members`, {
    headers: jsonHeaders(ownerToken),
  }).then((response) => body<Array<{ email: string; role: string }>>(response));
  assert.deepEqual(members.map((member) => [member.email, member.role]), [
    ['team-owner@example.com', 'owner'],
    ['second@example.com', 'developer'],
  ]);

  const remove = await fetch(
    `${baseUrl}/api/workspaces/${workspaceId}/members/${acceptedBody.user.id}`,
    { method: 'DELETE', headers: jsonHeaders(ownerToken) },
  );
  assert.equal(remove.status, 204);
  const removedSession = await fetch(`${baseUrl}/api/auth/session`, {
    headers: jsonHeaders(acceptedBody.session.token),
  });
  assert.equal(removedSession.status, 401);
});

test('workspace ownership transfer is reauthenticated, tenant-scoped, atomic, and auditable', async () => {
  const successorInvite = await createInvite('successor@example.com', 'admin');
  assert.equal(successorInvite.status, 201);
  const successorInvitation = await body<{ token: string }>(successorInvite);
  const successorAccept = await acceptInvite(successorInvitation.token, 'successor password value');
  assert.equal(successorAccept.status, 201);
  const successor = await body<{
    user: { id: number; role: string };
    session: { token: string };
  }>(successorAccept);

  const database = new SqliteDatabase(dbPath);
  const outsider = new UserRepository(database).createUser(
    'outsider@example.com',
    hashPassword('outsider password value'),
    true,
  );
  const endpoint = `${baseUrl}/api/workspaces/${workspaceId}/ownership`;

  const adminAttempt = await fetch(endpoint, {
    method: 'PUT',
    headers: jsonHeaders(successor.session.token),
    body: JSON.stringify({
      targetUserId: ownerUserId,
      password: 'successor password value',
      confirmTargetEmail: 'team-owner@example.com',
    }),
  });
  assert.equal(adminAttempt.status, 403);

  const wrongPassword = await transferOwnership({
    targetUserId: successor.user.id,
    password: 'wrong owner password',
    confirmTargetEmail: 'successor@example.com',
  });
  assert.equal(wrongPassword.status, 401);
  assert.equal(
    (await body<{ error: { code: string } }>(wrongPassword)).error.code,
    'REAUTHENTICATION_REQUIRED',
  );

  const crossTenantTarget = await transferOwnership({
    targetUserId: outsider.id,
    password: 'correct horse battery staple',
    confirmTargetEmail: 'outsider@example.com',
  });
  assert.equal(crossTenantTarget.status, 404);

  const wrongConfirmation = await transferOwnership({
    targetUserId: successor.user.id,
    password: 'correct horse battery staple',
    confirmTargetEmail: 'other@example.com',
  });
  assert.equal(wrongConfirmation.status, 400);

  const transferred = await transferOwnership({
    targetUserId: successor.user.id,
    password: 'correct horse battery staple',
    confirmTargetEmail: 'successor@example.com',
  });
  assert.equal(transferred.status, 200);
  const transfer = await body<{
    eventId: string;
    previousOwner: { userId: number; role: string };
    newOwner: { userId: number; role: string };
  }>(transferred);
  assert.ok(transfer.eventId);
  assert.deepEqual(transfer.previousOwner, {
    ...transfer.previousOwner,
    userId: ownerUserId,
    role: 'admin',
  });
  assert.deepEqual(transfer.newOwner, {
    ...transfer.newOwner,
    userId: successor.user.id,
    role: 'owner',
  });

  const previousOwnerSession = await fetch(`${baseUrl}/api/auth/session`, {
    headers: jsonHeaders(ownerToken),
  });
  assert.equal((await body<{ user: { role: string } }>(previousOwnerSession)).user.role, 'admin');
  const newOwnerSession = await fetch(`${baseUrl}/api/auth/session`, {
    headers: jsonHeaders(successor.session.token),
  });
  assert.equal((await body<{ user: { role: string } }>(newOwnerSession)).user.role, 'owner');

  const owners = database.query<{ count: number }>(`
    SELECT COUNT(*) AS count FROM workspace_memberships
    WHERE workspace_id = ${workspaceId} AND role = 'owner' AND status = 'active';
  `);
  assert.equal(Number(owners[0]?.count), 1);
  const events = database.query<{ event_id: string; initiated_by_user_id: number }>(`
    SELECT event_id, initiated_by_user_id FROM workspace_ownership_events;
  `);
  assert.deepEqual(events, [{ event_id: transfer.eventId, initiated_by_user_id: ownerUserId }]);
  assert.throws(
    () => database.run(`UPDATE workspace_ownership_events SET workspace_id = 99;`),
    /immutable/,
  );
  assert.throws(
    () => database.run(`DELETE FROM workspace_ownership_events;`),
    /immutable/,
  );

  const formerOwnerRetry = await transferOwnership({
    targetUserId: outsider.id,
    password: 'correct horse battery staple',
    confirmTargetEmail: 'outsider@example.com',
  });
  assert.equal(formerOwnerRetry.status, 403);
});

function createInvite(email: string, role: string): Promise<Response> {
  return fetch(`${baseUrl}/api/workspaces/${workspaceId}/invitations`, {
    method: 'POST',
    headers: jsonHeaders(ownerToken),
    body: JSON.stringify({ email, role }),
  });
}

function transferOwnership(input: {
  targetUserId: number;
  password: string;
  confirmTargetEmail: string;
}): Promise<Response> {
  return fetch(`${baseUrl}/api/workspaces/${workspaceId}/ownership`, {
    method: 'PUT',
    headers: jsonHeaders(ownerToken),
    body: JSON.stringify(input),
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for invitation email');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function acceptInvite(token: string, password: string): Promise<Response> {
  return fetch(`${baseUrl}/api/invitations/accept`, {
    method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ token, password }),
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
