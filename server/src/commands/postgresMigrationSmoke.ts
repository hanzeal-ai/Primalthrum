import { PostgresDatabase } from '../db/postgres';
import { POSTGRES_MIGRATIONS, runPostgresMigrations } from '../db/postgresMigrations';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');

  const database = new PostgresDatabase({ connectionString, max: 4 });
  try {
    const preMembershipMigrations = POSTGRES_MIGRATIONS.slice(0, -1);
    await Promise.all([
      runPostgresMigrations(database, preMembershipMigrations),
      runPostgresMigrations(database, preMembershipMigrations),
    ]);

    const users = await database.query<{ id: number }>({
      text: `
        INSERT INTO users (workspace_id, email, password_hash, role)
        VALUES ($1, $2, $3, $4)
        RETURNING id;
      `,
      values: [1, 'migration-smoke@example.com', 'hash', 'admin'],
    });
    const userId = users[0]?.id;
    if (!userId) throw new Error('PostgreSQL identity migration did not create a user');
    await database.execute({
      text: `
        INSERT INTO sessions (user_id, workspace_id, token_hash, expires_at)
        VALUES ($1, $2, $3, CURRENT_TIMESTAMP + INTERVAL '1 hour');
      `,
      values: [userId, 1, 'migration-smoke-token'],
    });
    await database.execute({
      text: `
        INSERT INTO provider_configs (workspace_id, name, type, config_json)
        VALUES ($1, $2, $3, $4);
      `,
      values: [1, 'shared-provider', 'llm', '{}'],
    });

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
    const secondWorkspaceId = inserted[0]!.id;
    await database.execute({
      text: `
        INSERT INTO provider_configs (workspace_id, name, type, config_json)
        VALUES ($1, $2, $3, $4);
      `,
      values: [secondWorkspaceId, 'shared-provider', 'llm', '{}'],
    });

    const memberships = await database.query<{ role: string }>({
      text: 'SELECT role FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2;',
      values: [1, userId],
    });
    if (memberships[0]?.role !== 'owner') throw new Error('legacy admin membership was not backfilled');
    const sessions = await database.query<{ active_workspace_id: number }>({
      text: 'SELECT active_workspace_id FROM sessions WHERE user_id = $1;',
      values: [userId],
    });
    if (Number(sessions[0]?.active_workspace_id) !== 1) {
      throw new Error('session active workspace was not backfilled');
    }
    const providerCount = await database.query<{ count: number }>({
      text: 'SELECT COUNT(*)::integer AS count FROM provider_configs WHERE name = $1;',
      values: ['shared-provider'],
    });
    if (Number(providerCount[0]?.count) !== 2) {
      throw new Error('provider names are not scoped by workspace');
    }

    const expectedTables = [
      'agent_configs',
      'agents',
      'conversation_messages',
      'conversations',
      'document_index_entries',
      'documents',
      'jobs',
      'provider_configs',
      'runs',
      'secrets',
      'sessions',
      'stream_events',
      'tool_audit_logs',
      'users',
      'workspace_invitations',
      'workspace_memberships',
      'workspaces',
    ];
    for (const table of expectedTables) {
      if ((await database.columns(table)).length === 0) {
        throw new Error(`PostgreSQL migration did not create ${table}`);
      }
    }
    if (!(await database.columns('documents')).some((column) => column.name === 'storage_ref')) {
      throw new Error('document storage reference migration was not applied');
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
