import { randomUUID } from 'node:crypto';

import { PostgresDatabase } from '../db/postgres';
import { runPostgresMigrations } from '../db/postgresMigrations';
import { DEFAULT_WORKSPACE_ID } from '../db/workspaceDefaults';
import { AsyncSessionRepository } from '../services/asyncSessionRepository';
import { AsyncUserRepository } from '../services/asyncUserRepository';
import { toPublicUserRecord } from '../services/userRepository';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');

  const database = new PostgresDatabase({ connectionString, max: 2 });
  const marker = randomUUID();
  const users = new AsyncUserRepository(database);
  const sessions = new AsyncSessionRepository(database);
  const createdUserIds: number[] = [];
  try {
    await runPostgresMigrations(database);

    if (!await users.hasAdmin()) throw new Error('PostgreSQL admin identity was not migrated');

    const member = await users.createUser(
      `identity-member-${marker}@example.com`,
      "hash with ' parameter",
      true,
    );
    createdUserIds.push(member.id);
    await database.execute({
      text: `
        INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
        VALUES ($1, $2, 'developer', 'active');
      `,
      values: [DEFAULT_WORKSPACE_ID, member.id],
    });

    const session = await sessions.create(toPublicUserRecord({ ...member, role: 'developer' }));
    const authenticated = await sessions.findByToken(session.token);
    if (
      authenticated?.user.id !== member.id
      || authenticated.user.role !== 'developer'
      || !authenticated.emailVerified
    ) {
      throw new Error('PostgreSQL session identity could not be authenticated');
    }
    if (!authenticated.expiresAt.endsWith('Z')) {
      throw new Error('PostgreSQL timestamp was not normalized to ISO format');
    }

    await sessions.markMfaAuthenticated(session.token, member.id);
    const securitySessions = await sessions.listForUser(member.id, session.token);
    if (
      securitySessions.length !== 1
      || !securitySessions[0]?.current
      || securitySessions[0].authenticationMethod !== 'totp'
      || !securitySessions[0].mfaAuthenticatedAt?.endsWith('Z')
    ) {
      throw new Error('PostgreSQL session security state is inconsistent');
    }

    await sessions.revokeToken(session.token);
    if (await sessions.findByToken(session.token)) {
      throw new Error('PostgreSQL revoked session remained active');
    }
    process.stdout.write('postgres identity repository smoke passed\n');
  } finally {
    for (const userId of createdUserIds) {
      await database.execute({
        text: 'DELETE FROM users WHERE id = $1;',
        values: [userId],
      }).catch(() => undefined);
    }
    await database.close();
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'postgres identity smoke failed'}\n`);
  process.exitCode = 1;
});
