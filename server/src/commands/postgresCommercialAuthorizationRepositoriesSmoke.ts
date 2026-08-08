import { randomUUID } from 'node:crypto';

import { PostgresDatabase } from '../db/postgres';
import { runPostgresMigrations } from '../db/postgresMigrations';
import { AsyncBillingPlanRepository } from '../services/asyncBillingPlanRepository';
import { AsyncEntitlementRepository } from '../services/asyncEntitlementRepository';
import { AsyncUserRepository } from '../services/asyncUserRepository';
import { AsyncWorkspaceRepository } from '../services/asyncWorkspaceRepository';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const database = new PostgresDatabase({ connectionString, max: 4 });
  const marker = randomUUID();
  const users = new AsyncUserRepository(database);
  const workspaces = new AsyncWorkspaceRepository(database);
  const plans = new AsyncBillingPlanRepository(database);
  const entitlements = new AsyncEntitlementRepository(
    database,
    () => new Date('2026-08-10T00:00:00.000Z'),
  );
  try {
    await runPostgresMigrations(database);
    const owner = await users.createUser(`commercial-auth-${marker}@example.com`, 'hash', true);
    const workspace = await workspaces.create(owner.id, `Commercial Auth ${marker}`);
    const catalog = await plans.list();
    const free = await entitlements.snapshot(workspace.id);
    await database.execute({
      text: `
        UPDATE workspace_subscriptions
        SET plan_key = 'pro', state = 'active'
        WHERE workspace_id = $1;
      `,
      values: [workspace.id],
    });
    const granted = await entitlements.grant({
      workspaceId: workspace.id,
      feature: 'agents.create',
      enabled: true,
      quantityLimit: 75,
      sourceType: 'enterprise',
      sourceRef: marker,
      priority: 200,
    });
    const grants = await database.query<{ count: number | string }>({
      text: `
        SELECT COUNT(*) AS count FROM credit_ledger_entries
        WHERE workspace_id = $1 AND source_type = 'plan';
      `,
      values: [workspace.id],
    });
    if (
      catalog.map((plan) => plan.key).join(',') !== 'free,pro,team,business,enterprise'
      || free.planKey !== 'free'
      || free.entitlements.voice?.enabled !== false
      || granted.planKey !== 'pro'
      || granted.entitlements.voice?.enabled !== true
      || granted.entitlements['agents.create']?.quantityLimit !== 75
      || Number(grants[0]?.count) !== 1
    ) {
      throw new Error('PostgreSQL commercial authorization state is inconsistent');
    }
    process.stdout.write('postgres commercial authorization repositories smoke passed\n');
  } finally {
    await database.close();
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'postgres commercial auth smoke failed'}\n`);
  process.exitCode = 1;
});
