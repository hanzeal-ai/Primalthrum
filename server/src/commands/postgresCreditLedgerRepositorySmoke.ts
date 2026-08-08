import { randomUUID } from 'node:crypto';

import { PostgresDatabase } from '../db/postgres';
import { runPostgresMigrations } from '../db/postgresMigrations';
import { AsyncCreditLedgerRepository } from '../services/asyncCreditLedgerRepository';
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
  const ledger = new AsyncCreditLedgerRepository(
    database,
    () => new Date('2026-08-15T12:00:00.000Z'),
  );
  try {
    await runPostgresMigrations(database);
    const owner = await users.createUser(`credit-ledger-${marker}@example.com`, 'hash', true);
    const workspace = await workspaces.create(owner.id, `Credit Ledger ${marker}`);
    const claims = await Promise.allSettled([
      ledger.reserve({
        workspaceId: workspace.id,
        idempotencyKey: `quota-a:${marker}`,
        meter: 'run.total',
        credits: 700,
      }),
      ledger.reserve({
        workspaceId: workspace.id,
        idempotencyKey: `quota-b:${marker}`,
        meter: 'run.total',
        credits: 700,
      }),
    ]);
    const accepted = claims.find((claim) => claim.status === 'fulfilled');
    const denied = claims.find((claim) => claim.status === 'rejected');
    if (!accepted || accepted.status !== 'fulfilled') {
      throw new Error('PostgreSQL credit reservation was not accepted');
    }
    if (
      !denied
      || denied.status !== 'rejected'
      || !(denied.reason instanceof BillingError)
      || denied.reason.code !== 'CREDIT_LIMIT_EXCEEDED'
    ) {
      throw new Error('PostgreSQL competing reservation was not denied');
    }
    const usage = await ledger.settle({
      workspaceId: workspace.id,
      reservationKey: accepted.value.idempotencyKey,
      usageIdempotencyKey: `usage:${marker}`,
      quantity: 1,
      actualCredits: 500,
      resourceType: 'run',
      resourceId: marker,
    });
    await ledger.refund({
      workspaceId: workspace.id,
      usageEventId: usage.id,
      credits: 100,
      idempotencyKey: `refund:${marker}`,
      sourceRef: marker,
    });
    let immutable = false;
    try {
      await database.execute({
        text: 'DELETE FROM usage_events WHERE id = $1;',
        values: [usage.id],
      });
    } catch (error) {
      if (!(error instanceof Error) || !/immutable/.test(error.message)) throw error;
      immutable = true;
    }
    const account = await ledger.account(workspace.id);
    if (
      !immutable
      || account.availableCredits !== 600
      || account.reservedCredits !== 0
      || account.spentCredits !== 400
      || !account.updatedAt.endsWith('Z')
      || usage.occurredAt !== '2026-08-15T12:00:00.000Z'
    ) {
      throw new Error('PostgreSQL credit ledger repository state is inconsistent');
    }
    process.stdout.write('postgres credit ledger repository smoke passed\n');
  } finally {
    await database.close();
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'postgres credit ledger smoke failed'}\n`);
  process.exitCode = 1;
});
