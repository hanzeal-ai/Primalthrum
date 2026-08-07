import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAsyncSqliteDatabase } from '../src/db/asyncDatabaseFactory';
import { type AsyncSqliteDatabase } from '../src/db/asyncSqlite';
import { AsyncSessionRepository } from '../src/services/asyncSessionRepository';
import { AsyncUserRepository } from '../src/services/asyncUserRepository';
import { toPublicUserRecord } from '../src/services/userRepository';

function createDatabase(): { database: AsyncSqliteDatabase; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'primalthrum-async-identity-'));
  return {
    database: createAsyncSqliteDatabase(join(root, 'database.sqlite')),
    root,
  };
}

test('async user repository manages normalized and verified identities', async () => {
  const { database, root } = createDatabase();
  const users = new AsyncUserRepository(database);
  try {
    assert.equal(await users.hasAdmin(), false);
    const admin = await users.createAdmin(' OWNER@Example.com ', 'admin-hash');
    assert.deepEqual(admin, {
      id: 1,
      workspaceId: 1,
      email: 'owner@example.com',
      role: 'admin',
    });
    assert.equal(await users.hasAdmin(), true);

    const member = await users.createUser(' MEMBER@Example.com ', 'initial-hash');
    assert.equal(member.email, 'member@example.com');
    assert.equal(member.emailVerifiedAt, null);
    await users.markEmailVerified(member.id, '2026-08-07T00:00:00.000Z');
    await users.updatePassword(member.id, 'updated-hash');

    const updated = await users.findByEmail('member@example.com');
    assert.equal(updated?.passwordHash, 'updated-hash');
    assert.equal(updated?.emailVerifiedAt, '2026-08-07T00:00:00.000Z');
    assert.deepEqual(await users.findById(member.id), updated);
    await assert.rejects(
      users.createUser("attacker@example.com'); DROP TABLE users; --", 'hash'),
      /email must be valid/,
    );
  } finally {
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('async session repository enforces membership and revocation boundaries', async () => {
  const { database, root } = createDatabase();
  const users = new AsyncUserRepository(database);
  const sessions = new AsyncSessionRepository(database);
  try {
    const admin = await users.createAdmin('sessions@example.com', 'hash');
    const current = await sessions.create(admin);
    const second = await sessions.create(admin, 'passkey');

    const authenticated = await sessions.findByToken(current.token);
    assert.equal(authenticated?.user.email, admin.email);
    assert.equal(authenticated?.emailVerified, true);
    assert.ok(authenticated?.expiresAt.endsWith('Z'));
    assert.equal(await sessions.findByToken(''), null);

    let activeSessions = await sessions.listForUser(admin.id, current.token);
    assert.equal(activeSessions.length, 2);
    assert.equal(activeSessions[0]?.current, true);
    const secondSession = activeSessions.find((session) => !session.current);
    assert.ok(secondSession);
    assert.equal(secondSession.authenticationMethod, 'passkey');
    assert.ok(secondSession.mfaAuthenticatedAt?.endsWith('Z'));
    await assert.rejects(
      sessions.revokeForUser(admin.id, activeSessions[0]!.id, current.token),
      /current session cannot be revoked/,
    );
    await sessions.revokeForUser(admin.id, secondSession.id, current.token);
    assert.equal(await sessions.findByToken(second.token), null);

    const workspaceRows = await database.query<{ id: number }>({
      text: `
        INSERT INTO workspaces (name, slug)
        VALUES ($1, $2)
        RETURNING id;
      `,
      values: ['Product workspace', 'product-workspace'],
    });
    const workspaceId = Number(workspaceRows[0]?.id);
    await database.execute({
      text: `
        INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
        VALUES ($1, $2, 'developer', 'active');
      `,
      values: [workspaceId, admin.id],
    });
    await sessions.switchWorkspace(current.token, admin.id, workspaceId);
    assert.deepEqual((await sessions.findByToken(current.token))?.user, {
      ...admin,
      workspaceId,
      role: 'developer',
    });
    await assert.rejects(
      sessions.switchWorkspace(current.token, admin.id, workspaceId + 1000),
      /workspace membership is required/,
    );

    await sessions.markMfaAuthenticated(current.token, admin.id);
    activeSessions = await sessions.listForUser(admin.id, current.token);
    assert.equal(activeSessions[0]?.authenticationMethod, 'totp');
    assert.ok(activeSessions[0]?.mfaAuthenticatedAt);
    await sessions.markPasswordAuthenticated(current.token, admin.id);
    assert.equal((await sessions.listForUser(admin.id, current.token))[0]?.mfaAuthenticatedAt, null);

    const another = await sessions.create(toPublicUserRecord({
      ...(await users.findById(admin.id))!,
      workspaceId,
      role: 'developer',
    }));
    assert.equal(await sessions.revokeOthers(admin.id, current.token), 1);
    assert.equal(await sessions.findByToken(another.token), null);
    await sessions.revokeToken(current.token);
    assert.equal(await sessions.findByToken(current.token), null);
  } finally {
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
