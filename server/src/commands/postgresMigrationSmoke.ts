import { PostgresDatabase } from '../db/postgres';
import { POSTGRES_MIGRATIONS, runPostgresMigrations } from '../db/postgresMigrations';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');

  const database = new PostgresDatabase({ connectionString, max: 4 });
  try {
    await Promise.all([
      runPostgresMigrations(database),
      runPostgresMigrations(database),
    ]);
    await runPostgresMigrations(database);

    const migrations = await database.query<{ id: string }>({
      text: 'SELECT id FROM schema_migrations ORDER BY id ASC;',
    });
    if (migrations.length !== POSTGRES_MIGRATIONS.length) {
      throw new Error('PostgreSQL migration count is not idempotent');
    }
    if (migrations.some((migration, index) => migration.id !== POSTGRES_MIGRATIONS[index]?.id)) {
      throw new Error('PostgreSQL migrations were not applied in order');
    }

    const workspace = await database.query<{ id: number; name: string; slug: string }>({
      text: 'SELECT id, name, slug FROM workspaces WHERE id = $1;',
      values: [1],
    });
    if (workspace[0]?.slug !== 'local') throw new Error('default workspace was not migrated');

    const inserted = await database.query<{ id: number }>({
      text: `
        INSERT INTO workspaces (name, slug)
        VALUES ($1, $2)
        RETURNING id;
      `,
      values: ['Migration smoke', 'migration-smoke'],
    });
    if (Number(inserted[0]?.id) <= 1) throw new Error('workspace identity sequence was not advanced');

    const expectedTables = [
      'agent_configs',
      'agents',
      'documents',
      'provider_configs',
      'runs',
      'stream_events',
      'workspaces',
    ];
    for (const table of expectedTables) {
      if ((await database.columns(table)).length === 0) {
        throw new Error(`PostgreSQL migration did not create ${table}`);
      }
    }
    process.stdout.write(`postgres migrations smoke passed: ${migrations.length} migration(s)\n`);
  } finally {
    await database.close();
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'postgres migration smoke failed'}\n`);
  process.exitCode = 1;
});
