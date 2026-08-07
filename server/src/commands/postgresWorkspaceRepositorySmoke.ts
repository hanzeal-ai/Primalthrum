import { randomUUID } from 'node:crypto';

import { PostgresDatabase } from '../db/postgres';
import { runPostgresMigrations } from '../db/postgresMigrations';
import { AsyncUserRepository } from '../services/asyncUserRepository';
import { AsyncWorkspaceRepository } from '../services/asyncWorkspaceRepository';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');

  const database = new PostgresDatabase({ connectionString, max: 4 });
  const marker = randomUUID();
  const users = new AsyncUserRepository(database);
  const workspaces = new AsyncWorkspaceRepository(database);
  const createdUserIds: number[] = [];
  const createdWorkspaceIds: number[] = [];
  try {
    await runPostgresMigrations(database);
    const owner = await users.createUser(`workspace-owner-${marker}@example.com`, 'hash', true);
    const member = await users.createUser(`workspace-member-${marker}@example.com`, 'hash', true);
    createdUserIds.push(owner.id, member.id);

    const workspaceName = `Workspace ${marker}`;
    const workspace = await workspaces.create(owner.id, workspaceName);
    const secondWorkspace = await workspaces.create(owner.id, workspaceName);
    createdWorkspaceIds.push(workspace.id, secondWorkspace.id);
    if (secondWorkspace.slug !== `${workspace.slug}-2`) {
      throw new Error('PostgreSQL workspace slug allocation is inconsistent');
    }

    const invitation = await workspaces.createInvitation({
      workspaceId: workspace.id,
      email: member.email,
      role: 'developer',
      invitedByUserId: owner.id,
    });
    const results = await Promise.allSettled([
      workspaces.acceptInvitation(invitation.token, member.id, member.email),
      workspaces.acceptInvitation(invitation.token, member.id, member.email),
    ]);
    if (
      results.filter((result) => result.status === 'fulfilled').length !== 1
      || results.filter((result) => result.status === 'rejected').length !== 1
    ) {
      throw new Error('PostgreSQL invitation was not consumed exactly once');
    }
    const membership = await workspaces.findMembership(workspace.id, member.id);
    if (membership?.role !== 'developer' || !membership.createdAt.endsWith('Z')) {
      throw new Error('PostgreSQL workspace membership is inconsistent');
    }
    if (await workspaces.activeInvitationByToken(invitation.token)) {
      throw new Error('PostgreSQL accepted invitation remained active');
    }
    process.stdout.write('postgres workspace repository smoke passed\n');
  } finally {
    for (const workspaceId of createdWorkspaceIds.reverse()) {
      await database.execute({
        text: 'DELETE FROM workspaces WHERE id = $1;',
        values: [workspaceId],
      }).catch(() => undefined);
    }
    for (const userId of createdUserIds.reverse()) {
      await database.execute({
        text: 'DELETE FROM users WHERE id = $1;',
        values: [userId],
      }).catch(() => undefined);
    }
    await database.close();
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'postgres workspace smoke failed'}\n`);
  process.exitCode = 1;
});
