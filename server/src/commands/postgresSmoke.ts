import { randomUUID } from 'node:crypto';

import { PostgresDatabase } from '../db/postgres';

interface SmokeRow {
  id: string;
  value: string;
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');

  const database = new PostgresDatabase({
    connectionString,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 5_000,
    max: 2,
  });
  const marker = randomUUID();
  const untrustedValue = "postgres smoke ' parameter";

  try {
    await database.transaction(async (transaction) => {
      await transaction.execute({
        text: 'CREATE TEMP TABLE primalthrum_smoke (id TEXT PRIMARY KEY, value TEXT NOT NULL);',
      });
      await transaction.execute({
        text: 'INSERT INTO primalthrum_smoke (id, value) VALUES ($1, $2);',
        values: [marker, untrustedValue],
      });
      const rows = await transaction.query<SmokeRow>({
        text: 'SELECT id, value FROM primalthrum_smoke WHERE id = $1;',
        values: [marker],
      });
      if (rows.length !== 1 || rows[0]?.value !== untrustedValue) {
        throw new Error('PostgreSQL parameterized query returned unexpected data');
      }
    });

    await database.execute({
      text: 'CREATE TABLE primalthrum_rollback (id TEXT PRIMARY KEY);',
    });
    try {
      await database.transaction(async (transaction) => {
        await transaction.execute({
          text: 'INSERT INTO primalthrum_rollback (id) VALUES ($1);',
          values: [marker],
        });
        throw new Error('expected rollback marker');
      });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'expected rollback marker') throw error;
    }
    const rollbackRows = await database.query<{ count: number }>({
      text: 'SELECT COUNT(*)::integer AS count FROM primalthrum_rollback;',
    });
    if (Number(rollbackRows[0]?.count) !== 0) {
      throw new Error('PostgreSQL transaction rollback retained inserted data');
    }
    await database.execute({ text: 'DROP TABLE primalthrum_rollback;' });

    const health = await database.query<{ healthy: number }>({ text: 'SELECT 1 AS healthy;' });
    if (Number(health[0]?.healthy) !== 1) throw new Error('PostgreSQL health query failed');
    process.stdout.write('postgres connection pool smoke passed\n');
  } finally {
    await database.close();
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'postgres smoke failed'}\n`);
  process.exitCode = 1;
});
