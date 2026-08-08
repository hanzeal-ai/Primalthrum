import { PostgresDatabase } from '../db/postgres';
import { runPostgresMigrations } from '../db/postgresMigrations';
import { AsyncUserRepository } from '../services/asyncUserRepository';
import { AsyncWorkspaceRepository } from '../services/asyncWorkspaceRepository';
import { AsyncWorkspaceLegalHoldRepository } from '../services/asyncWorkspaceLegalHoldRepository';
import { WorkspaceLegalHoldError } from '../services/workspaceLegalHoldRepository';
import { hashPassword } from '../services/passwordHash';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const database = new PostgresDatabase({ connectionString, max: 8 });
  try {
    await runPostgresMigrations(database);
    const suffix = Date.now();
    const user = await new AsyncUserRepository(database).createUser(
      `legal-hold-${suffix}@example.com`,
      hashPassword('correct horse battery staple'),
      true,
    );
    const workspace = await new AsyncWorkspaceRepository(database).create(
      user.id,
      `Legal Hold ${suffix}`,
    );
    const operatorIds: number[] = [];
    for (const index of [1, 2, 3]) {
      const rows = await database.query<{ id: number }>({
        text: `
          INSERT INTO operator_users (
            email, password_hash, role, must_change_password, bootstrap_root
          ) VALUES ($1, $2, 'security', FALSE, FALSE)
          RETURNING id;
        `,
        values: [
          `legal-hold-operator-${suffix}-${index}@example.com`,
          hashPassword(`operator password ${suffix} ${index}`),
        ],
      });
      operatorIds.push(Number(rows[0]?.id));
    }
    const repository = new AsyncWorkspaceLegalHoldRepository(
      database,
      () => new Date('2026-08-08T12:00:00.000Z'),
    );
    const hold = await repository.create({
      workspaceId: workspace.id,
      externalCaseRef: `CASE-${suffix}`,
      basis: 'regulatory',
      reason: 'Preserve workspace records for a regulatory response.',
      operatorUserId: operatorIds[0],
    });
    if ((await repository.activeCount(workspace.id)) !== 1 || (await repository.list())[0]?.id !== hold.id) {
      throw new Error('PostgreSQL legal hold placement was not visible');
    }

    const attempts = await Promise.allSettled([
      repository.release(hold.id, {
        expectedRevision: 1,
        releaseReason: 'The regulator confirmed that preservation may end.',
        operatorUserId: operatorIds[1],
      }),
      repository.release(hold.id, {
        expectedRevision: 1,
        releaseReason: 'The regulator confirmed that preservation may end.',
        operatorUserId: operatorIds[2],
      }),
    ]);
    const fulfilled = attempts.filter((attempt) => attempt.status === 'fulfilled');
    const rejected = attempts.filter((attempt) => attempt.status === 'rejected');
    if (
      fulfilled.length !== 1
      || rejected.length !== 1
      || !(rejected[0] as PromiseRejectedResult).reason
      || !((rejected[0] as PromiseRejectedResult).reason instanceof WorkspaceLegalHoldError)
      || ((rejected[0] as PromiseRejectedResult).reason as WorkspaceLegalHoldError).code !== 'REVISION_CONFLICT'
    ) {
      throw new Error('PostgreSQL legal hold release was not serialized');
    }

    const evidence = await database.query<{
      status: string;
      revision: number;
      events: number | string;
    }>({
      text: `
        SELECT hold.status, hold.revision,
          (SELECT COUNT(*) FROM workspace_legal_hold_events event
            WHERE event.legal_hold_id = hold.id) AS events
        FROM workspace_legal_holds hold WHERE hold.id = $1;
      `,
      values: [hold.id],
    });
    if (
      evidence[0]?.status !== 'released'
      || Number(evidence[0]?.revision) !== 2
      || Number(evidence[0]?.events) !== 2
      || (await repository.activeCount(workspace.id)) !== 0
    ) {
      throw new Error('PostgreSQL legal hold evidence is inconsistent');
    }
    process.stdout.write('postgres workspace legal hold repository smoke passed\n');
  } finally {
    await database.close();
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'postgres legal hold smoke failed'}\n`);
  process.exitCode = 1;
});
