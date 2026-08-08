import { randomUUID } from 'node:crypto';

import { PostgresDatabase } from '../db/postgres';
import { runPostgresMigrations } from '../db/postgresMigrations';
import { AsyncCreditLedgerRepository } from '../services/asyncCreditLedgerRepository';
import { AsyncEntitlementRepository } from '../services/asyncEntitlementRepository';
import { AsyncTrialRepository } from '../services/asyncTrialRepository';
import { AsyncUserRepository } from '../services/asyncUserRepository';
import { AsyncWorkspaceRepository } from '../services/asyncWorkspaceRepository';
import { BillingError } from '../services/billingTypes';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const database = new PostgresDatabase({ connectionString, max: 4 });
  const marker = randomUUID();
  const users = new AsyncUserRepository(database);
  const workspaces = new AsyncWorkspaceRepository(database);
  const now = () => new Date('2026-08-01T00:00:00.000Z');
  const trials = new AsyncTrialRepository(database, now);
  const credits = new AsyncCreditLedgerRepository(database, now);
  const entitlements = new AsyncEntitlementRepository(database, now);
  try {
    await runPostgresMigrations(database);
    const owner = await users.createUser(`trial-${marker}@example.com`, 'hash', true);
    const first = await workspaces.create(owner.id, `Trial One ${marker}`);
    const second = await workspaces.create(owner.id, `Trial Two ${marker}`);
    const results = await Promise.allSettled([
      trials.activate(first.id, owner.id),
      trials.activate(second.id, owner.id),
    ]);
    const accepted = results.find((result) => result.status === 'fulfilled');
    const rejected = results.find((result) => result.status === 'rejected');
    if (!accepted || accepted.status !== 'fulfilled') {
      throw new Error('PostgreSQL Trial activation was not accepted');
    }
    if (
      !rejected
      || rejected.status !== 'rejected'
      || !(rejected.reason instanceof BillingError)
      || rejected.reason.code !== 'TRIAL_NOT_ELIGIBLE'
    ) {
      throw new Error('PostgreSQL duplicate Trial activation was not rejected');
    }
    const account = await credits.account(accepted.value.workspaceId);
    const snapshot = await entitlements.snapshot(accepted.value.workspaceId);
    if (
      accepted.value.endsAt !== '2026-08-08T00:00:00.000Z'
      || account.availableCredits !== 10_000
      || snapshot.planKey !== 'pro'
      || snapshot.entitlements.voice?.enabled !== true
    ) {
      throw new Error('PostgreSQL Trial repository state is inconsistent');
    }
    process.stdout.write('postgres Trial repository smoke passed\n');
  } finally {
    await database.close();
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'postgres Trial smoke failed'}\n`);
  process.exitCode = 1;
});
