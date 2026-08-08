import { randomUUID } from 'node:crypto';

import { PostgresDatabase } from '../db/postgres';
import { runPostgresMigrations } from '../db/postgresMigrations';
import { AsyncUsageRatingRepository } from '../services/asyncUsageRatingRepository';
import { AsyncUserRepository } from '../services/asyncUserRepository';
import { AsyncWorkspaceRepository } from '../services/asyncWorkspaceRepository';
import { UsageRatingError } from '../services/usageRatingTypes';

const NOW = new Date('2026-08-15T12:00:00.000Z');

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');

  const database = new PostgresDatabase({ connectionString, max: 4 });
  const marker = randomUUID();
  const users = new AsyncUserRepository(database);
  const workspaces = new AsyncWorkspaceRepository(database);
  const ratings = new AsyncUsageRatingRepository(database, () => NOW);
  try {
    await runPostgresMigrations(database);
    const owner = await users.createUser(`usage-rating-${marker}@example.com`, 'hash', true);
    const workspace = await workspaces.create(owner.id, `Usage Rating ${marker}`);
    const isolated = await workspaces.create(owner.id, `Usage Isolated ${marker}`);
    await ratings.setControls({
      workspaceId: workspace.id,
      monthlyCreditLimit: 20,
      hardLimit: true,
      alertThresholds: [50, 100],
      updatedByUserId: owner.id,
    });
    const [first, replay] = await Promise.all([
      ratings.rate({
        workspaceId: workspace.id,
        idempotencyKey: `smoke:${marker}`,
        meter: 'llm.input_tokens',
        quantity: 1500,
        resourceType: 'run',
        resourceId: marker,
        occurredAt: NOW.toISOString(),
      }),
      ratings.rate({
        workspaceId: workspace.id,
        idempotencyKey: `smoke:${marker}`,
        meter: 'llm.input_tokens',
        quantity: 1500,
        resourceType: 'run',
        resourceId: marker,
        occurredAt: NOW.toISOString(),
      }),
    ]);
    let limited = false;
    try {
      await ratings.rate({
        workspaceId: workspace.id,
        idempotencyKey: `smoke-over:${marker}`,
        meter: 'hosted.runs',
        quantity: 1,
        occurredAt: NOW.toISOString(),
      });
    } catch (error) {
      if (!(error instanceof UsageRatingError) || error.code !== 'MONTHLY_CREDIT_LIMIT_EXCEEDED') {
        throw error;
      }
      limited = true;
    }
    let immutable = false;
    try {
      await database.execute({
        text: 'DELETE FROM rated_usage_events WHERE id = $1;',
        values: [first.id],
      });
    } catch (error) {
      if (!(error instanceof Error) || !/immutable/.test(error.message)) throw error;
      immutable = true;
    }
    const summary = await ratings.summary(workspace.id, NOW);
    if (
      !limited
      || !immutable
      || first.id !== replay.id
      || !first.createdAt.endsWith('Z')
      || summary.eventCount !== 1
      || summary.creditsCharged !== 20
      || (await ratings.listAlerts(workspace.id)).length !== 2
      || (await ratings.summary(isolated.id, NOW)).eventCount !== 0
    ) {
      throw new Error('PostgreSQL usage rating repository state is inconsistent');
    }
    process.stdout.write('postgres usage rating repository smoke passed\n');
  } finally {
    await database.close();
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'postgres usage rating smoke failed'}\n`);
  process.exitCode = 1;
});
