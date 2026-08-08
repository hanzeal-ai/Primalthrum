import { PostgresDatabase } from '../db/postgres';
import { runPostgresMigrations } from '../db/postgresMigrations';
import { AsyncOperatorFeatureFlagRepository } from '../services/asyncOperatorFeatureFlagRepository';
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
      `operator-flag-${suffix}@example.com`,
      hashPassword('correct horse battery staple'),
      true,
    );
    const workspace = await new AsyncWorkspaceRepository(database).create(
      owner.id,
      `Operator Flag ${suffix}`,
    );
    const operators = await database.query<{ id: number }>({
      text: `
        INSERT INTO operator_users (email, password_hash, role, must_change_password)
        VALUES ($1, $3, 'security', FALSE), ($2, $3, 'security', FALSE)
        RETURNING id;
      `,
      values: [
        `flag-security-${suffix}-1@example.com`,
        `flag-security-${suffix}-2@example.com`,
        hashPassword('operator feature flag password'),
      ],
    });
    const firstOperatorId = Number(operators[0]?.id);
    const secondOperatorId = Number(operators[1]?.id);
    const first = new AsyncOperatorFeatureFlagRepository(database);
    const second = new AsyncOperatorFeatureFlagRepository(database);
    const flag = await first.create({
      key: `operator.flag.${suffix}`,
      description: 'Exercise PostgreSQL feature flag revision controls.',
      enabled: true,
      killSwitch: false,
      rolloutPercentage: 100,
      operatorUserId: firstOperatorId,
    });
    const updates = await Promise.allSettled([
      first.update(flag.id, {
        description: 'First competing PostgreSQL feature flag update.',
        enabled: true,
        killSwitch: false,
        rolloutPercentage: 75,
        expectedRevision: 1,
        operatorUserId: firstOperatorId,
      }),
      second.update(flag.id, {
        description: 'Second competing PostgreSQL feature flag update.',
        enabled: true,
        killSwitch: false,
        rolloutPercentage: 50,
        expectedRevision: 1,
        operatorUserId: secondOperatorId,
      }),
    ]);
    if (updates.filter((result) => result.status === 'fulfilled').length !== 1) {
      throw new Error('PostgreSQL feature flag update was not revision-serialized');
    }
    const overrides = await Promise.allSettled([
      first.createOverride(flag.id, {
        workspaceId: workspace.id,
        enabled: false,
        reason: 'Disable this feature for the smoke Workspace.',
        operatorUserId: firstOperatorId,
      }),
      second.createOverride(flag.id, {
        workspaceId: workspace.id,
        enabled: true,
        reason: 'Competing override for the same smoke Workspace.',
        operatorUserId: secondOperatorId,
      }),
    ]);
    const created = overrides.filter((result) => result.status === 'fulfilled');
    if (created.length !== 1) {
      throw new Error('PostgreSQL active feature flag override was not unique or effective');
    }
    const override = (created[0] as PromiseFulfilledResult<{ id: number; enabled: boolean }>).value;
    if (await first.evaluate(flag.key, { workspaceId: workspace.id }) !== override.enabled) {
      throw new Error('PostgreSQL active feature flag override was not unique or effective');
    }
    const revoked = await second.revokeOverride(flag.id, override.id, {
      expectedRevision: 1,
      operatorUserId: secondOperatorId,
    });
    const events = await first.listEvents(flag.id, 10);
    if (revoked.active || revoked.revision !== 2 || events.length !== 4) {
      throw new Error('PostgreSQL feature flag lifecycle evidence is inconsistent');
    }
    let immutable = false;
    try {
      await database.execute({
        text: 'DELETE FROM operator_feature_flag_events WHERE feature_flag_id = $1;',
        values: [flag.id],
      });
    } catch {
      immutable = true;
    }
    if (!immutable) throw new Error('PostgreSQL feature flag events were deletable');
    process.stdout.write('postgres operator feature flag repository smoke passed\n');
  } finally {
    await database.close();
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'postgres feature flag smoke failed'}\n`);
  process.exitCode = 1;
});
