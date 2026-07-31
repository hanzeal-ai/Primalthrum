import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { createApp } from '../src/app';
import { SqliteDatabase, sqlValue } from '../src/db/sqlite';
import { BillingRepository } from '../src/services/billingRepository';
import { hashPassword } from '../src/services/passwordHash';
import { hashToken, SessionRepository } from '../src/services/sessionRepository';
import { totpAt } from '../src/services/totp';
import { UserRepository } from '../src/services/userRepository';
import { WorkspaceRepository, WORKSPACE_ROLES } from '../src/services/workspaceRepository';

const OWNER_EMAIL = 'mfa-owner@example.com';
const PASSWORD = 'correct horse battery staple';

let rootDir = '';
let dbPath = '';
let server: Server;
let baseUrl = '';
let ownerToken = '';
let ownerId = 0;
let ownerWorkspaceId = 0;
let secret = '';
let recoveryCodes: string[] = [];

before(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'primalthrum-mfa-'));
  dbPath = join(rootDir, 'platform.sqlite');
  server = createApp({
    dbPath,
    documentStorageDir: join(rootDir, 'documents'),
    generatedAgentsDir: join(rootDir, 'agents'),
    logger: { log: () => undefined },
  }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;

  const setup = await fetch(`${baseUrl}/api/setup/admin`, {
    method: 'POST', headers: jsonHeaders(),
    body: JSON.stringify({ email: OWNER_EMAIL, password: PASSWORD }),
  });
  assert.equal(setup.status, 201);
  const payload = await body<{ user: { id: number; workspaceId: number }; session: { token: string } }>(setup);
  ownerToken = payload.session.token;
  ownerId = payload.user.id;
  ownerWorkspaceId = payload.user.workspaceId;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(rootDir, { recursive: true, force: true });
});

test('all workspace roles can read and manage account-level MFA', async () => {
  const db = new SqliteDatabase(dbPath);
  const users = new UserRepository(db);
  const workspaces = new WorkspaceRepository(db);
  const sessions = new SessionRepository(db);
  for (const role of WORKSPACE_ROLES) {
    if (role === 'owner') continue;
    const user = users.createUser(`${role}@example.com`, hashPassword(PASSWORD), true);
    db.run(`
      INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
      VALUES (${sqlValue(ownerWorkspaceId)}, ${sqlValue(user.id)}, ${sqlValue(role)}, 'active');
    `);
    const principal = workspaces.principalForUser(user.id, ownerWorkspaceId);
    assert(principal);
    const session = sessions.create(principal);
    const response = await fetch(`${baseUrl}/api/settings/mfa`, { headers: jsonHeaders(session.token) });
    assert.equal(response.status, 200, `role ${role} should read its own MFA status`);
    assert.equal((await body<{ enabled: boolean }>(response)).enabled, false);
    const setup = await fetch(`${baseUrl}/api/settings/mfa/setup`, {
      method: 'POST',
      headers: jsonHeaders(session.token),
      body: JSON.stringify({ password: PASSWORD }),
    });
    assert.equal(setup.status, 201, `role ${role} should manage its own MFA factor`);
  }
});

test('MFA setup encrypts the secret, upgrades the current session, and revokes other sessions', async () => {
  const secondLogin = await passwordLogin();
  assert.equal(secondLogin.status, 200);
  const secondToken = (await body<{ session: { token: string } }>(secondLogin)).session.token;

  const denied = await fetch(`${baseUrl}/api/settings/mfa/setup`, {
    method: 'POST', headers: jsonHeaders(ownerToken), body: JSON.stringify({ password: 'wrong password value' }),
  });
  assert.equal(denied.status, 401);

  const setup = await fetch(`${baseUrl}/api/settings/mfa/setup`, {
    method: 'POST', headers: jsonHeaders(ownerToken), body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(setup.status, 201);
  const setupBody = await body<{ secret: string; otpauthUri: string }>(setup);
  secret = setupBody.secret;
  assert.match(setupBody.otpauthUri, /^otpauth:\/\/totp\//);

  const db = new SqliteDatabase(dbPath);
  const stored = db.query<{ ciphertext: string; secret_ref: string }>(`
    SELECT s.ciphertext, f.secret_ref
    FROM user_mfa_factors f JOIN secrets s ON s.secret_ref = f.secret_ref
    WHERE f.user_id = ${sqlValue(ownerId)};
  `)[0];
  assert(stored);
  assert.notEqual(stored.ciphertext, secret);
  assert.doesNotMatch(JSON.stringify(stored), new RegExp(secret));

  const confirm = await fetch(`${baseUrl}/api/settings/mfa/confirm`, {
    method: 'POST', headers: jsonHeaders(ownerToken), body: JSON.stringify({ code: totpAt(secret) }),
  });
  assert.equal(confirm.status, 200);
  const confirmed = await body<{ enabled: boolean; recoveryCodes: string[]; recoveryCodesRemaining: number }>(confirm);
  assert.equal(confirmed.enabled, true);
  assert.equal(confirmed.recoveryCodesRemaining, 10);
  recoveryCodes = confirmed.recoveryCodes;
  assert.equal(recoveryCodes.length, 10);
  assert.equal((await fetch(`${baseUrl}/api/auth/session`, { headers: jsonHeaders(secondToken) })).status, 401);

  const sessions = await fetch(`${baseUrl}/api/settings/sessions`, { headers: jsonHeaders(ownerToken) });
  const current = (await body<Array<{ current: boolean; authenticationMethod: string }>>(sessions))
    .find((record) => record.current);
  assert.equal(current?.authenticationMethod, 'totp');
});

test('login requires a one-use MFA challenge and rejects replayed credentials', async () => {
  const login = await passwordLogin();
  assert.equal(login.status, 202);
  const challenge = await body<{ mfaRequired: boolean; challengeToken: string; methods: string[] }>(login);
  assert.equal(challenge.mfaRequired, true);
  assert.deepEqual(challenge.methods, ['totp', 'recovery_code']);

  const wrong = await verifyChallenge(challenge.challengeToken, '000000');
  assert.equal(wrong.status, 401);

  const futureCode = totpAt(secret, Date.now() + 30_000);
  const verified = await verifyChallenge(challenge.challengeToken, futureCode);
  assert.equal(verified.status, 200);
  const token = (await body<{ session: { token: string } }>(verified)).session.token;
  assert.equal((await fetch(`${baseUrl}/api/auth/session`, { headers: jsonHeaders(token) })).status, 200);
  assert.equal((await verifyChallenge(challenge.challengeToken, futureCode)).status, 401);

  const recoveryLogin = await passwordLogin();
  const recoveryChallenge = await body<{ challengeToken: string }>(recoveryLogin);
  const recovered = await verifyChallenge(recoveryChallenge.challengeToken, recoveryCodes[0]);
  assert.equal(recovered.status, 200);

  const replayLogin = await passwordLogin();
  const replayChallenge = await body<{ challengeToken: string }>(replayLogin);
  assert.equal((await verifyChallenge(replayChallenge.challengeToken, recoveryCodes[0])).status, 401);
});

test('an MFA challenge is locked after five failed attempts', async () => {
  const login = await passwordLogin();
  const challenge = await body<{ challengeToken: string }>(login);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal((await verifyChallenge(challenge.challengeToken, '000000')).status, 401);
  }
  const db = new SqliteDatabase(dbPath);
  const stored = db.query<{ attempts: number }>(`
    SELECT attempts FROM user_mfa_challenges
    WHERE token_hash = ${sqlValue(hashToken(challenge.challengeToken))};
  `)[0];
  assert.equal(Number(stored?.attempts), 5);
  assert.equal(db.query<{ count: number }>(`
    SELECT COUNT(*) AS count FROM user_mfa_challenges
    WHERE token_hash = ${sqlValue(hashToken(challenge.challengeToken))}
      AND attempts < 5 AND consumed_at IS NULL AND revoked_at IS NULL;
  `)[0]?.count, 0);
});

test('an existing MFA user must complete MFA before an invitation is consumed', async () => {
  const db = new SqliteDatabase(dbPath);
  const users = new UserRepository(db);
  const workspaces = new WorkspaceRepository(db);
  const inviter = users.createUser('inviter@example.com', hashPassword(PASSWORD), true);
  const invitedWorkspace = workspaces.create(inviter.id, 'MFA Invitation Workspace');
  new BillingRepository(db).grantEntitlement({
    workspaceId: invitedWorkspace.id,
    feature: 'seats',
    enabled: true,
    quantityLimit: 5,
    sourceType: 'test',
    sourceRef: 'mfa-invitation',
  });
  const invitation = workspaces.createInvitation({
    workspaceId: invitedWorkspace.id,
    email: OWNER_EMAIL,
    role: 'developer',
    invitedByUserId: inviter.id,
  });

  const accept = await fetch(`${baseUrl}/api/invitations/accept`, {
    method: 'POST', headers: jsonHeaders(),
    body: JSON.stringify({ token: invitation.token, password: PASSWORD }),
  });
  assert.equal(accept.status, 202);
  assert.equal(workspaces.activeInvitationByToken(invitation.token)?.acceptedAt, null);
  const challenge = await body<{ challengeToken: string }>(accept);

  const verified = await verifyChallenge(challenge.challengeToken, recoveryCodes[1]);
  assert.equal(verified.status, 201);
  const result = await body<{ user: { workspaceId: number; role: string } }>(verified);
  assert.equal(result.user.workspaceId, invitedWorkspace.id);
  assert.equal(result.user.role, 'developer');
  assert.equal(workspaces.activeInvitationByToken(invitation.token), null);
});

test('MFA can be disabled with password and an unused recovery code', async () => {
  const disabled = await fetch(`${baseUrl}/api/settings/mfa`, {
    method: 'DELETE', headers: jsonHeaders(ownerToken),
    body: JSON.stringify({ password: PASSWORD, code: recoveryCodes[2] }),
  });
  assert.equal(disabled.status, 204);
  const status = await fetch(`${baseUrl}/api/settings/mfa`, { headers: jsonHeaders(ownerToken) });
  assert.equal((await body<{ enabled: boolean }>(status)).enabled, false);
  assert.equal((await passwordLogin()).status, 200);
  const db = new SqliteDatabase(dbPath);
  assert.equal(db.query<{ count: number }>(`
    SELECT COUNT(*) AS count FROM user_mfa_factors WHERE user_id = ${sqlValue(ownerId)};
  `)[0]?.count, 0);
});

function passwordLogin(): Promise<Response> {
  return fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ email: OWNER_EMAIL, password: PASSWORD }),
  });
}

function verifyChallenge(challengeToken: string, code: string): Promise<Response> {
  return fetch(`${baseUrl}/api/auth/mfa/verify`, {
    method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ challengeToken, code }),
  });
}

function jsonHeaders(token = ''): Record<string, string> {
  return { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
}

function body<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}
