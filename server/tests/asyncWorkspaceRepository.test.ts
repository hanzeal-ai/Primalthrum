import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAsyncSqliteDatabase } from '../src/db/asyncDatabaseFactory';
import { type AsyncSqliteDatabase } from '../src/db/asyncSqlite';
import { AsyncUserRepository } from '../src/services/asyncUserRepository';
import { AsyncWorkspaceRepository } from '../src/services/asyncWorkspaceRepository';

function createDatabase(): { database: AsyncSqliteDatabase; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'primalthrum-async-workspace-'));
  return {
    database: createAsyncSqliteDatabase(join(root, 'database.sqlite')),
    root,
  };
}

test('async workspace repository creates unique slugs and protects owners', async () => {
  const { database, root } = createDatabase();
  const users = new AsyncUserRepository(database);
  const workspaces = new AsyncWorkspaceRepository(database);
  try {
    const owner = await users.createAdmin('workspace-owner@example.com', 'hash');
    const first = await workspaces.create(owner.id, ' Roadmap Lab ');
    const second = await workspaces.create(owner.id, 'Roadmap Lab');

    assert.equal(first.slug, 'roadmap-lab');
    assert.equal(second.slug, 'roadmap-lab-2');
    assert.ok(first.createdAt.endsWith('Z'));
    assert.deepEqual(await workspaces.findById(first.id), first);
    assert.deepEqual(await workspaces.findBySlug(second.slug), second);
    assert.deepEqual(await workspaces.principalForUser(owner.id, first.id), {
      id: owner.id,
      workspaceId: first.id,
      email: owner.email,
      role: 'owner',
    });
    assert.equal((await workspaces.listForUser(owner.id)).length, 3);
    await assert.rejects(
      workspaces.updateMemberRole(first.id, owner.id, 'admin'),
      /owner role cannot be changed/,
    );
    await assert.rejects(
      workspaces.removeMember(first.id, owner.id),
      /owner cannot be removed/,
    );
  } finally {
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('async workspace invitations are single-use and enforce member roles', async () => {
  const { database, root } = createDatabase();
  const users = new AsyncUserRepository(database);
  const workspaces = new AsyncWorkspaceRepository(database);
  try {
    const owner = await users.createAdmin('invitation-owner@example.com', 'hash');
    const member = await users.createUser('invited-member@example.com', 'hash', true);
    const workspace = await workspaces.create(owner.id, 'Invitation Lab');
    const invitation = await workspaces.createInvitation({
      workspaceId: workspace.id,
      email: ' INVITED-MEMBER@example.com ',
      role: 'developer',
      invitedByUserId: owner.id,
    });

    assert.equal(invitation.email, member.email);
    assert.ok(invitation.expiresAt.endsWith('Z'));
    assert.equal(await workspaces.pendingInvitationCount(workspace.id), 1);
    assert.equal(await workspaces.pendingInvitationCount(workspace.id, member.email), 0);
    assert.equal((await workspaces.activeInvitationByToken(invitation.token))?.id, invitation.id);
    await assert.rejects(
      workspaces.acceptInvitation(invitation.token, member.id, 'wrong@example.com'),
      /email does not match/,
    );

    const membership = await workspaces.acceptInvitation(
      invitation.token,
      member.id,
      member.email,
    );
    assert.equal(membership.role, 'developer');
    assert.equal(await workspaces.activeInvitationByToken(invitation.token), null);
    assert.equal(await workspaces.pendingInvitationCount(workspace.id), 0);
    assert.equal((await workspaces.listMembers(workspace.id)).length, 2);
    assert.equal((await workspaces.principalForUser(member.id, workspace.id))?.role, 'developer');
    assert.equal((await workspaces.updateMemberRole(workspace.id, member.id, 'billing')).role, 'billing');
    await assert.rejects(
      workspaces.validateInvitationTarget(workspace.id, member.email),
      /already a workspace member/,
    );
    await assert.rejects(
      workspaces.revokeInvitation(workspace.id, invitation.id),
      /accepted invitation cannot be revoked/,
    );

    await workspaces.removeMember(workspace.id, member.id);
    const replacement = await workspaces.createInvitation({
      workspaceId: workspace.id,
      email: member.email,
      role: 'viewer',
      invitedByUserId: owner.id,
    });
    const results = await Promise.allSettled([
      workspaces.acceptInvitation(replacement.token, member.id, member.email),
      workspaces.acceptInvitation(replacement.token, member.id, member.email),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);

    await workspaces.removeMember(workspace.id, member.id);
    const revoked = await workspaces.createInvitation({
      workspaceId: workspace.id,
      email: member.email,
      role: 'member',
      invitedByUserId: owner.id,
    });
    await workspaces.revokeInvitation(workspace.id, revoked.id);
    assert.equal(await workspaces.activeInvitationByToken(revoked.token), null);
    await assert.rejects(
      workspaces.acceptInvitation(revoked.token, member.id, member.email),
      /invalid or no longer active/,
    );
  } finally {
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
