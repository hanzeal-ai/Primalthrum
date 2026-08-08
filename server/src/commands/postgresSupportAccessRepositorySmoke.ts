import { PostgresDatabase } from '../db/postgres';
import { runPostgresMigrations } from '../db/postgresMigrations';
import { AsyncSupportAccessRepository } from '../services/asyncSupportAccessRepository';
import { AsyncUserRepository } from '../services/asyncUserRepository';
import { AsyncWorkspaceRepository } from '../services/asyncWorkspaceRepository';
import { hashPassword } from '../services/passwordHash';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const database = new PostgresDatabase({ connectionString, max: 8 });
  try {
    await runPostgresMigrations(database);
    const suffix = Date.now();
    const owner = await new AsyncUserRepository(database).createUser(
      `support-access-${suffix}@example.com`,
      hashPassword('correct horse battery staple'),
      true,
    );
    const workspace = await new AsyncWorkspaceRepository(database).create(
      owner.id,
      `Support Access ${suffix}`,
    );
    const operators = await database.query<{ id: number; role: string }>({
      text: `
        INSERT INTO operator_users (email, password_hash, role, must_change_password)
        VALUES
          ($1, $3, 'super_admin', FALSE),
          ($2, $3, 'support', FALSE)
        RETURNING id, role;
      `,
      values: [
        `support-manager-${suffix}@example.com`,
        `support-assignee-${suffix}@example.com`,
        hashPassword('operator support access password'),
      ],
    });
    const managerId = Number(operators.find((operator) => operator.role === 'super_admin')?.id);
    const supportId = Number(operators.find((operator) => operator.role === 'support')?.id);
    let now = new Date('2026-08-08T12:00:00.000Z');
    const first = new AsyncSupportAccessRepository(database, () => now);
    const second = new AsyncSupportAccessRepository(database, () => now);
    const attempts = await Promise.allSettled([
      first.create({
        workspaceId: workspace.id,
        operatorUserId: supportId,
        permissions: ['workspace.metadata.read', 'workspace.jobs.read'],
        reason: 'Investigate a customer-reported failed Agent run.',
        ticketRef: `SUP-${suffix}`,
        expiresAt: '2026-08-08T13:00:00.000Z',
        createdByOperatorId: managerId,
      }),
      second.create({
        workspaceId: workspace.id,
        operatorUserId: supportId,
        permissions: ['workspace.metadata.read'],
        reason: 'Investigate the same customer support request.',
        ticketRef: `SUP-${suffix}-DUPLICATE`,
        expiresAt: '2026-08-08T13:00:00.000Z',
        createdByOperatorId: managerId,
      }),
    ]);
    const created = attempts.filter((attempt) => attempt.status === 'fulfilled');
    if (created.length !== 1) throw new Error('PostgreSQL concurrent support grants were not serialized');
    const grant = (created[0] as PromiseFulfilledResult<{ id: number }>).value;
    const active = await first.findActive(grant.id, supportId);
    if (!active || active.status !== 'active' || (await first.list(supportId)).length !== 1) {
      throw new Error('PostgreSQL support grant was not active and scoped');
    }
    const revoked = await second.revoke(grant.id, managerId);
    if (revoked?.status !== 'revoked' || await first.findActive(grant.id, supportId)) {
      throw new Error('PostgreSQL support grant revocation was not durable');
    }
    let immutable = false;
    try {
      await database.execute({
        text: 'DELETE FROM operator_support_grants WHERE id = $1;',
        values: [grant.id],
      });
    } catch {
      immutable = true;
    }
    if (!immutable) throw new Error('PostgreSQL support grant evidence was deletable');
    process.stdout.write('postgres support access repository smoke passed\n');
  } finally {
    await database.close();
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'postgres support access smoke failed'}\n`);
  process.exitCode = 1;
});
