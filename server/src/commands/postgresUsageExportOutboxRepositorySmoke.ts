import { randomUUID } from 'node:crypto';

import { PostgresDatabase } from '../db/postgres';
import { runPostgresMigrations } from '../db/postgresMigrations';
import { AsyncUsageExportOutboxRepository } from '../services/asyncUsageExportOutboxRepository';
import { AsyncUsageRatingRepository } from '../services/asyncUsageRatingRepository';
import { AsyncUserRepository } from '../services/asyncUserRepository';
import { AsyncWorkspaceRepository } from '../services/asyncWorkspaceRepository';
import { UsageExportDispatcher } from '../services/usageExportDispatcher';
import { type UsageMeterExportPayload } from '../services/usageMeterExporter';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');

  const database = new PostgresDatabase({ connectionString, max: 4 });
  const marker = randomUUID();
  const users = new AsyncUserRepository(database);
  const workspaces = new AsyncWorkspaceRepository(database);
  const ratings = new AsyncUsageRatingRepository(
    database,
    () => new Date('2026-08-15T12:00:00.000Z'),
  );
  const firstOutbox = new AsyncUsageExportOutboxRepository(database);
  const secondOutbox = new AsyncUsageExportOutboxRepository(database);
  try {
    await runPostgresMigrations(database);
    const owner = await users.createUser(`usage-export-${marker}@example.com`, 'hash', true);
    const workspace = await workspaces.create(owner.id, `Usage Export ${marker}`);
    const rated = await ratings.rate({
      workspaceId: workspace.id,
      idempotencyKey: `export:${marker}`,
      meter: 'api.runs',
      quantity: 1,
      occurredAt: '2026-08-15T12:00:00.000Z',
    });
    const delivered: UsageMeterExportPayload[] = [];
    const exporter = {
      destination: 'primary',
      send: async (payload: UsageMeterExportPayload) => { delivered.push(payload); },
    };
    const logger = { log: () => undefined };
    await Promise.all([
      new UsageExportDispatcher(firstOutbox, exporter, logger).drain(),
      new UsageExportDispatcher(secondOutbox, exporter, logger).drain(),
    ]);
    const rows = await database.query<{ status: string; attempts: number }>({
      text: `
        SELECT status, attempts FROM usage_meter_exports
        WHERE rated_usage_event_id = $1;
      `,
      values: [rated.id],
    });
    const matchingDeliveries = delivered.filter((payload) => payload.eventId === rated.id);
    if (
      matchingDeliveries.length !== 1
      || !matchingDeliveries[0]?.createdAt.endsWith('Z')
      || rows[0]?.status !== 'delivered'
      || Number(rows[0]?.attempts) !== 1
    ) {
      throw new Error('PostgreSQL usage export outbox state is inconsistent');
    }
    process.stdout.write('postgres usage export outbox repository smoke passed\n');
  } finally {
    await database.close();
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'postgres usage export smoke failed'}\n`);
  process.exitCode = 1;
});
