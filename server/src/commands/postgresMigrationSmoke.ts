import { PostgresDatabase } from '../db/postgres';
import { POSTGRES_MIGRATIONS, runPostgresMigrations } from '../db/postgresMigrations';
import {
  POSTGRES_COMMERCIAL_TABLES,
  seedRatedUsageBeforeOutbox,
  verifyCommercialMigrations,
} from './postgresMigrationBillingSmoke';
import {
  POSTGRES_SECURITY_TABLES,
  verifySecurityMigrations,
} from './postgresMigrationSecuritySmoke';

function migrationsThrough(id: string) {
  const index = POSTGRES_MIGRATIONS.findIndex((migration) => migration.id === id);
  if (index < 0) throw new Error(`PostgreSQL smoke migration is missing: ${id}`);
  return POSTGRES_MIGRATIONS.slice(0, index + 1);
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');

  const database = new PostgresDatabase({ connectionString, max: 4 });
  try {
    const preMembershipMigrations = migrationsThrough('008_conversations');
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

    const membershipMigrations = migrationsThrough('009_workspace_memberships');
    await Promise.all([
      runPostgresMigrations(database, membershipMigrations),
      runPostgresMigrations(database, membershipMigrations),
    ]);

    const legacyAgents = await database.query<{ id: number }>({
      text: `
        INSERT INTO agents (workspace_id, name, slug, path, status)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id;
      `,
      values: [1, 'Migration Agent', 'migration-agent', '/tmp/migration-agent', 'generated'],
    });
    const legacyAgentId = legacyAgents[0]?.id;
    if (!legacyAgentId) throw new Error('PostgreSQL core migration did not create an agent');
    await database.execute({
      text: 'INSERT INTO agent_configs (agent_id, config_json) VALUES ($1, $2);',
      values: [legacyAgentId, '{"model":"migration-smoke"}'],
    });
    const documents = await database.query<{ id: number }>({
      text: `
        INSERT INTO documents (agent_id, workspace_id, filename, hash, status)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id;
      `,
      values: [legacyAgentId, 1, 'migration.txt', 'migration-hash', 'indexed'],
    });
    const documentId = documents[0]?.id;
    if (!documentId) throw new Error('PostgreSQL document migration did not create a document');
    await database.execute({
      text: `
        INSERT INTO document_index_entries (
          workspace_id, agent_id, document_id, chunk_id, text
        ) VALUES ($1, $2, $3, $4, $5);
      `,
      values: [1, legacyAgentId, documentId, 'migration-chunk', 'migration content'],
    });

    const preOutboxMigrations = migrationsThrough('017_usage_rating_cost_controls');
    await Promise.all([
      runPostgresMigrations(database, preOutboxMigrations),
      runPostgresMigrations(database, preOutboxMigrations),
    ]);
    const preOutboxRatedUsageId = await seedRatedUsageBeforeOutbox(database);
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

    const versions = await database.query<{ status: string; checksum: string }>({
      text: 'SELECT status, checksum FROM agent_versions WHERE agent_id = $1;',
      values: [legacyAgentId],
    });
    if (versions[0]?.status !== 'published' || versions[0]?.checksum !== 'legacy-import') {
      throw new Error('legacy generated Agent version was not backfilled');
    }
    const deployments = await database.query<{ url_path: string }>({
      text: `
        SELECT url_path
        FROM agent_deployments
        WHERE agent_id = $1 AND environment = 'production' AND status = 'active';
      `,
      values: [legacyAgentId],
    });
    if (deployments[0]?.url_path !== '/a/migration-agent') {
      throw new Error('legacy generated Agent deployment was not backfilled');
    }

    await database.execute({
      text: `
        INSERT INTO runs (
          agent_id, workspace_id, input, status, idempotency_key, request_hash
        ) VALUES ($1, $2, $3, $4, $5, $6);
      `,
      values: [legacyAgentId, 1, 'migration run', 'pending', 'migration-key', 'request-hash'],
    });
    let duplicateIdempotencyRejected = false;
    try {
      await database.execute({
        text: `
          INSERT INTO runs (
            agent_id, workspace_id, input, status, idempotency_key, request_hash
          ) VALUES ($1, $2, $3, $4, $5, $6);
        `,
        values: [legacyAgentId, 1, 'duplicate run', 'pending', 'migration-key', 'other-hash'],
      });
    } catch {
      duplicateIdempotencyRejected = true;
    }
    if (!duplicateIdempotencyRejected) throw new Error('run idempotency index is not enforced');

    await database.execute({
      text: `
        INSERT INTO workspace_capability_settings (
          workspace_id, capability_key, enabled, updated_by_user_id
        ) VALUES ($1, $2, $3, $4);
      `,
      values: [1, 'rag:sqlite', true, userId],
    });
    const capability = await database.query<{ enabled: boolean }>({
      text: `
        SELECT enabled
        FROM workspace_capability_settings
        WHERE workspace_id = $1 AND capability_key = $2;
      `,
      values: [1, 'rag:sqlite'],
    });
    if (capability[0]?.enabled !== true) throw new Error('workspace capability migration failed');

    const documentMetadata = await database.query<{ mime_type: string; size_bytes: number }>({
      text: 'SELECT mime_type, size_bytes FROM documents WHERE id = $1;',
      values: [documentId],
    });
    if (documentMetadata[0]?.mime_type !== 'text/plain'
      || Number(documentMetadata[0]?.size_bytes) !== 0) {
      throw new Error('document upload metadata defaults were not migrated');
    }
    const vectorMetadata = await database.query<{
      embedding_json: string;
      vector_store: string;
    }>({
      text: `
        SELECT embedding_json, vector_store
        FROM document_index_entries
        WHERE document_id = $1;
      `,
      values: [documentId],
    });
    if (vectorMetadata[0]?.embedding_json !== '[]' || vectorMetadata[0]?.vector_store !== '') {
      throw new Error('document vector metadata defaults were not migrated');
    }
    await verifyCommercialMigrations(database, userId, preOutboxRatedUsageId);
    await verifySecurityMigrations(database, userId);

    const expectedTables = [
      'agent_configs',
      'agent_deployments',
      'agent_versions',
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
      'workspace_capability_settings',
      'workspaces',
      ...POSTGRES_COMMERCIAL_TABLES,
      ...POSTGRES_SECURITY_TABLES,
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
