import { randomUUID } from 'node:crypto';

import { PostgresDatabase } from '../db/postgres';
import { runPostgresMigrations } from '../db/postgresMigrations';
import { DEFAULT_WORKSPACE_ID } from '../db/workspaceDefaults';
import { AsyncJobRepository } from '../services/asyncJobRepository';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');

  const database = new PostgresDatabase({ connectionString, max: 4 });
  const marker = randomUUID();
  const firstWorker = new AsyncJobRepository(database);
  const secondWorker = new AsyncJobRepository(database);
  const type = `smoke.job.${marker}`;
  const createdIds: number[] = [];
  try {
    await runPostgresMigrations(database);
    const first = await firstWorker.createUnique({
      type,
      workspaceId: DEFAULT_WORKSPACE_ID,
      payload: { marker, order: 1 },
      dedupeKey: 'order:1',
    });
    const duplicate = await secondWorker.createUnique({
      type,
      workspaceId: DEFAULT_WORKSPACE_ID,
      payload: { marker, order: 1 },
      dedupeKey: 'order:1',
    });
    const second = await firstWorker.createUnique({
      type,
      workspaceId: DEFAULT_WORKSPACE_ID,
      payload: { marker, order: 2 },
      dedupeKey: 'order:2',
    });
    if (!first || !second) throw new Error('PostgreSQL Job smoke could not create jobs');
    createdIds.push(first.id, second.id);

    const claims = await Promise.all([
      firstWorker.claimNext([type]),
      secondWorker.claimNext([type]),
    ]);
    const claimedIds = claims.flatMap((job) => job ? [job.id] : []);
    if (
      duplicate !== null
      || claimedIds.length !== 2
      || new Set(claimedIds).size !== 2
      || claims.some((job) => job?.status !== 'running' || job.attempts !== 1)
      || await firstWorker.findByIdInWorkspace(first.id, 999_999) !== null
    ) {
      throw new Error('PostgreSQL Job atomic claim or tenant state is inconsistent');
    }
    await Promise.all(claims.map((job) => (
      job ? firstWorker.markSucceeded(job.id, { marker, completed: true }) : Promise.resolve()
    )));

    const retry = await firstWorker.createUnique({
      type,
      workspaceId: DEFAULT_WORKSPACE_ID,
      payload: { marker, order: 3 },
      maxAttempts: 2,
      dedupeKey: 'order:3',
    });
    if (!retry) throw new Error('PostgreSQL Job retry case could not be created');
    createdIds.push(retry.id);
    const firstAttempt = await firstWorker.claimNext([type]);
    if (!firstAttempt || firstAttempt.id !== retry.id) throw new Error('PostgreSQL Job retry was not claimed');
    await firstWorker.markFailed(firstAttempt.id, 'retry smoke');
    const secondAttempt = await secondWorker.claimNext([type]);
    if (!secondAttempt || secondAttempt.attempts !== 2) {
      throw new Error('PostgreSQL Job retry attempt was not preserved');
    }
    const failed = await secondWorker.markFailed(secondAttempt.id, 'final smoke');
    if (failed.status !== 'failed' || !failed.completedAt?.endsWith('Z')) {
      throw new Error('PostgreSQL Job terminal failure state is inconsistent');
    }
    process.stdout.write('postgres Job repository smoke passed\n');
  } finally {
    if (createdIds.length) {
      await database.execute({
        text: `DELETE FROM jobs WHERE id IN (${createdIds.map((_, index) => `$${index + 1}`).join(', ')});`,
        values: createdIds,
      }).catch(() => undefined);
    }
    await database.close();
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'postgres Job smoke failed'}\n`);
  process.exitCode = 1;
});
