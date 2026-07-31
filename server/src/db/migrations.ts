import { type DatabaseAdapter } from './adapter';
import { sqlValue } from './sqlite';
import {
  DEFAULT_WORKSPACE_ID,
  DEFAULT_WORKSPACE_NAME,
  DEFAULT_WORKSPACE_SLUG,
} from './workspaceDefaults';

export interface Migration {
  id: string;
  up: (db: DatabaseAdapter) => void;
}

export const MIGRATIONS: Migration[] = [
  {
    id: '001_platform_metadata',
    up: applyPlatformMetadata,
  },
  {
    id: '002_admin_sessions',
    up: applyAdminSessions,
  },
  {
    id: '003_secret_references',
    up: applySecretReferences,
  },
  {
    id: '004_tool_audit_logs',
    up: applyToolAuditLogs,
  },
  {
    id: '005_background_jobs',
    up: applyBackgroundJobs,
  },
  {
    id: '006_document_storage_refs',
    up: applyDocumentStorageRefs,
  },
  {
    id: '007_document_index_entries',
    up: applyDocumentIndexEntries,
  },
  {
    id: '008_conversations',
    up: applyConversations,
  },
  {
    id: '009_workspace_memberships',
    up: applyWorkspaceMemberships,
  },
  {
    id: '010_agent_versions_deployments',
    up: applyAgentVersionsAndDeployments,
  },
  {
    id: '011_run_idempotency',
    up: applyRunIdempotency,
  },
  {
    id: '012_workspace_capabilities',
    up: applyWorkspaceCapabilities,
  },
  {
    id: '013_document_upload_metadata',
    up: applyDocumentUploadMetadata,
  },
  {
    id: '014_document_vector_metadata',
    up: applyDocumentVectorMetadata,
  },
  {
    id: '015_billing_entitlements_ledger',
    up: applyBillingEntitlementsLedger,
  },
];

export function runMigrations(db: DatabaseAdapter): void {
  ensureMigrationTable(db);
  const applied = new Set(
    db.query<{ id: string }>('SELECT id FROM schema_migrations;')
      .map((row) => row.id),
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) {
      continue;
    }

    migration.up(db);
    db.run(`
      INSERT INTO schema_migrations (id)
      VALUES (${sqlValue(migration.id)});
    `);
  }
}

function ensureMigrationTable(db: DatabaseAdapter): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function applyPlatformMetadata(db: DatabaseAdapter): void {
  db.run(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS workspaces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    INSERT OR IGNORE INTO workspaces (id, name, slug)
    VALUES (
      ${DEFAULT_WORKSPACE_ID},
      ${sqlValue(DEFAULT_WORKSPACE_NAME)},
      ${sqlValue(DEFAULT_WORKSPACE_SLUG)}
    );

    CREATE TABLE IF NOT EXISTS agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL DEFAULT ${DEFAULT_WORKSPACE_ID},
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      path TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS agent_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER NOT NULL UNIQUE,
      config_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER NOT NULL,
      workspace_id INTEGER NOT NULL DEFAULT ${DEFAULT_WORKSPACE_ID},
      input TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ended_at TEXT,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS stream_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      node TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER NOT NULL,
      workspace_id INTEGER NOT NULL DEFAULT ${DEFAULT_WORKSPACE_ID},
      filename TEXT NOT NULL,
      hash TEXT NOT NULL,
      status TEXT NOT NULL,
      collection TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS provider_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL DEFAULT ${DEFAULT_WORKSPACE_ID},
      name TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      config_json TEXT NOT NULL,
      secret_ref TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );
  `);

  const defaultWorkspaceColumn = `INTEGER NOT NULL DEFAULT ${DEFAULT_WORKSPACE_ID}`;
  ensureColumn(db, 'agents', 'workspace_id', defaultWorkspaceColumn);
  ensureColumn(db, 'runs', 'workspace_id', defaultWorkspaceColumn);
  ensureColumn(db, 'documents', 'workspace_id', defaultWorkspaceColumn);
  ensureColumn(db, 'provider_configs', 'workspace_id', defaultWorkspaceColumn);
  backfillDefaultWorkspace(db);
}

function applyAdminSessions(db: DatabaseAdapter): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL DEFAULT ${DEFAULT_WORKSPACE_ID},
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      workspace_id INTEGER NOT NULL DEFAULT ${DEFAULT_WORKSPACE_ID},
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );
  `);
}

function applySecretReferences(db: DatabaseAdapter): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS secrets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL DEFAULT ${DEFAULT_WORKSPACE_ID},
      secret_ref TEXT NOT NULL UNIQUE,
      ciphertext TEXT NOT NULL,
      iv TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );
  `);
}

function applyToolAuditLogs(db: DatabaseAdapter): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS tool_audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL DEFAULT ${DEFAULT_WORKSPACE_ID},
      run_id INTEGER NOT NULL,
      event_id INTEGER NOT NULL UNIQUE,
      tool_name TEXT NOT NULL,
      status TEXT NOT NULL,
      dangerous INTEGER NOT NULL DEFAULT 0,
      node TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE,
      FOREIGN KEY(event_id) REFERENCES stream_events(id) ON DELETE CASCADE
    );
  `);
}

function applyBackgroundJobs(db: DatabaseAdapter): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL DEFAULT ${DEFAULT_WORKSPACE_ID},
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      payload_json TEXT NOT NULL,
      result_json TEXT NOT NULL DEFAULT '{}',
      error TEXT NOT NULL DEFAULT '',
      run_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );
  `);
}

function applyDocumentStorageRefs(db: DatabaseAdapter): void {
  ensureColumn(db, 'documents', 'storage_ref', "TEXT NOT NULL DEFAULT ''");
}

function applyDocumentIndexEntries(db: DatabaseAdapter): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS document_index_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL DEFAULT ${DEFAULT_WORKSPACE_ID},
      agent_id INTEGER NOT NULL,
      document_id INTEGER NOT NULL,
      chunk_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(document_id, chunk_id),
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE CASCADE,
      FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE
    );
  `);
}

function applyConversations(db: DatabaseAdapter): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL DEFAULT ${DEFAULT_WORKSPACE_ID},
      agent_id INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS conversation_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL DEFAULT ${DEFAULT_WORKSPACE_ID},
      conversation_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      sources_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );
  `);
}

function applyWorkspaceMemberships(db: DatabaseAdapter): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS workspace_memberships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(workspace_id, user_id),
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS workspace_invitations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      email TEXT NOT NULL,
      role TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      invited_by_user_id INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      accepted_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(invited_by_user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    INSERT OR IGNORE INTO workspace_memberships (
      workspace_id,
      user_id,
      role,
      status
    )
    SELECT
      workspace_id,
      id,
      CASE WHEN role = 'admin' THEN 'owner' ELSE 'member' END,
      'active'
    FROM users;
  `);

  db.run(`
    ALTER TABLE provider_configs RENAME TO provider_configs_legacy;

    CREATE TABLE provider_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL DEFAULT ${DEFAULT_WORKSPACE_ID},
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      config_json TEXT NOT NULL,
      secret_ref TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(workspace_id, name),
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    INSERT INTO provider_configs (
      id,
      workspace_id,
      name,
      type,
      config_json,
      secret_ref,
      created_at
    )
    SELECT
      id,
      workspace_id,
      name,
      type,
      config_json,
      secret_ref,
      created_at
    FROM provider_configs_legacy;

    DROP TABLE provider_configs_legacy;
  `);

  ensureColumn(
    db,
    'sessions',
    'active_workspace_id',
    `INTEGER NOT NULL DEFAULT ${DEFAULT_WORKSPACE_ID}`,
  );
  db.run(`
    UPDATE sessions
    SET active_workspace_id = workspace_id
    WHERE active_workspace_id IS NULL;
  `);
}

function applyAgentVersionsAndDeployments(db: DatabaseAdapter): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS agent_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      agent_id INTEGER NOT NULL,
      version_number INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'preview',
      config_json TEXT NOT NULL,
      source_path TEXT NOT NULL DEFAULT '',
      checksum TEXT NOT NULL,
      created_by_user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      published_at TEXT,
      UNIQUE(agent_id, version_number),
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE CASCADE,
      FOREIGN KEY(created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS agent_deployments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      agent_id INTEGER NOT NULL,
      version_id INTEGER NOT NULL,
      environment TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      trigger TEXT NOT NULL DEFAULT 'publish',
      url_path TEXT NOT NULL,
      created_by_user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      activated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      deactivated_at TEXT,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE CASCADE,
      FOREIGN KEY(version_id) REFERENCES agent_versions(id) ON DELETE CASCADE,
      FOREIGN KEY(created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );
  `);

  ensureColumn(db, 'agents', 'preview_version_id', 'INTEGER');
  ensureColumn(db, 'agents', 'published_version_id', 'INTEGER');
  ensureColumn(db, 'runs', 'agent_version_id', 'INTEGER');

  db.run(`
    INSERT OR IGNORE INTO agent_versions (
      workspace_id,
      agent_id,
      version_number,
      status,
      config_json,
      source_path,
      checksum,
      published_at
    )
    SELECT
      a.workspace_id,
      a.id,
      1,
      'published',
      c.config_json,
      a.path,
      'legacy-import',
      CURRENT_TIMESTAMP
    FROM agents a
    JOIN agent_configs c ON c.agent_id = a.id
    WHERE a.status = 'generated';

    UPDATE agents
    SET published_version_id = (
      SELECT v.id
      FROM agent_versions v
      WHERE v.agent_id = agents.id AND v.version_number = 1
    )
    WHERE status = 'generated' AND published_version_id IS NULL;

    INSERT INTO agent_deployments (
      workspace_id,
      agent_id,
      version_id,
      environment,
      status,
      trigger,
      url_path
    )
    SELECT
      a.workspace_id,
      a.id,
      a.published_version_id,
      'production',
      'active',
      'migration',
      '/a/' || a.slug
    FROM agents a
    WHERE a.published_version_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM agent_deployments d
        WHERE d.agent_id = a.id AND d.environment = 'production'
      );
  `);
}

function applyRunIdempotency(db: DatabaseAdapter): void {
  ensureColumn(db, 'runs', 'idempotency_key', 'TEXT');
  ensureColumn(db, 'runs', 'request_hash', `TEXT NOT NULL DEFAULT ''`);
  ensureColumn(db, 'runs', 'conversation_id', 'INTEGER');
  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_workspace_idempotency
    ON runs(workspace_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
  `);
}

function applyWorkspaceCapabilities(db: DatabaseAdapter): void {
  ensureColumn(db, 'runs', 'capability_snapshot_json', `TEXT NOT NULL DEFAULT '{}'`);
  db.run(`
    CREATE TABLE IF NOT EXISTS workspace_capability_settings (
      workspace_id INTEGER NOT NULL,
      capability_key TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_by_user_id INTEGER,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(workspace_id, capability_key),
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(updated_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );
  `);
}

function applyDocumentUploadMetadata(db: DatabaseAdapter): void {
  ensureColumn(db, 'documents', 'mime_type', `TEXT NOT NULL DEFAULT 'text/plain'`);
  ensureColumn(db, 'documents', 'size_bytes', 'INTEGER NOT NULL DEFAULT 0');
}

function applyDocumentVectorMetadata(db: DatabaseAdapter): void {
  ensureColumn(db, 'document_index_entries', 'embedding_json', `TEXT NOT NULL DEFAULT '[]'`);
  ensureColumn(db, 'document_index_entries', 'embedding_provider', `TEXT NOT NULL DEFAULT ''`);
  ensureColumn(db, 'document_index_entries', 'embedding_model', `TEXT NOT NULL DEFAULT ''`);
  ensureColumn(db, 'document_index_entries', 'vector_store', `TEXT NOT NULL DEFAULT ''`);
}

function applyBillingEntitlementsLedger(db: DatabaseAdapter): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS billing_plans (
      key TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      currency TEXT NOT NULL DEFAULT 'usd',
      monthly_price_minor INTEGER NOT NULL DEFAULT 0 CHECK(monthly_price_minor >= 0),
      monthly_credit_grant INTEGER NOT NULL DEFAULT 0 CHECK(monthly_credit_grant >= 0),
      trial_credit_grant INTEGER NOT NULL DEFAULT 0 CHECK(trial_credit_grant >= 0),
      trial_days INTEGER NOT NULL DEFAULT 0 CHECK(trial_days >= 0),
      overage_enabled INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS plan_entitlements (
      plan_key TEXT NOT NULL,
      feature_key TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      quantity_limit INTEGER,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY(plan_key, feature_key),
      FOREIGN KEY(plan_key) REFERENCES billing_plans(key) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS workspace_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL UNIQUE,
      plan_key TEXT NOT NULL,
      state TEXT NOT NULL,
      period_starts_at TEXT NOT NULL,
      period_ends_at TEXT,
      trial_ends_at TEXT,
      cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
      provider TEXT NOT NULL DEFAULT '',
      provider_customer_ref TEXT NOT NULL DEFAULT '',
      provider_subscription_ref TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(plan_key) REFERENCES billing_plans(key)
    );

    CREATE TABLE IF NOT EXISTS trial_grants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL UNIQUE,
      user_id INTEGER NOT NULL UNIQUE,
      plan_key TEXT NOT NULL,
      credit_amount INTEGER NOT NULL CHECK(credit_amount > 0),
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(plan_key) REFERENCES billing_plans(key)
    );

    CREATE TABLE IF NOT EXISTS entitlement_grants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      feature_key TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      quantity_limit INTEGER,
      source_type TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 100,
      starts_at TEXT NOT NULL,
      ends_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(workspace_id, source_type, source_ref, feature_key),
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS credit_accounts (
      workspace_id INTEGER PRIMARY KEY,
      available_credits INTEGER NOT NULL DEFAULT 0 CHECK(available_credits >= 0),
      reserved_credits INTEGER NOT NULL DEFAULT 0 CHECK(reserved_credits >= 0),
      spent_credits INTEGER NOT NULL DEFAULT 0 CHECK(spent_credits >= 0),
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS credit_reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL,
      meter TEXT NOT NULL,
      reserved_credits INTEGER NOT NULL CHECK(reserved_credits > 0),
      settled_credits INTEGER,
      state TEXT NOT NULL DEFAULT 'reserved',
      usage_event_id INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      settled_at TEXT,
      released_at TEXT,
      UNIQUE(workspace_id, idempotency_key),
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      reservation_id INTEGER NOT NULL UNIQUE,
      idempotency_key TEXT NOT NULL,
      meter TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK(quantity >= 0),
      credits_charged INTEGER NOT NULL CHECK(credits_charged >= 0),
      resource_type TEXT NOT NULL DEFAULT '',
      resource_id TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(workspace_id, idempotency_key),
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(reservation_id) REFERENCES credit_reservations(id)
    );

    CREATE TABLE IF NOT EXISTS credit_ledger_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL,
      event_type TEXT NOT NULL,
      available_delta INTEGER NOT NULL DEFAULT 0,
      reserved_delta INTEGER NOT NULL DEFAULT 0,
      spent_delta INTEGER NOT NULL DEFAULT 0,
      reservation_id INTEGER,
      usage_event_id INTEGER,
      source_type TEXT NOT NULL DEFAULT '',
      source_ref TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(workspace_id, idempotency_key),
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(reservation_id) REFERENCES credit_reservations(id),
      FOREIGN KEY(usage_event_id) REFERENCES usage_events(id)
    );

    CREATE TRIGGER IF NOT EXISTS credit_ledger_apply
    AFTER INSERT ON credit_ledger_entries
    BEGIN
      INSERT OR IGNORE INTO credit_accounts (workspace_id)
      VALUES (NEW.workspace_id);
      UPDATE credit_accounts
      SET available_credits = available_credits + NEW.available_delta,
          reserved_credits = reserved_credits + NEW.reserved_delta,
          spent_credits = spent_credits + NEW.spent_delta,
          updated_at = CURRENT_TIMESTAMP
      WHERE workspace_id = NEW.workspace_id;
    END;

    CREATE TRIGGER IF NOT EXISTS credit_ledger_no_update
    BEFORE UPDATE ON credit_ledger_entries
    BEGIN
      SELECT RAISE(ABORT, 'credit ledger entries are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS credit_ledger_no_delete
    BEFORE DELETE ON credit_ledger_entries
    BEGIN
      SELECT RAISE(ABORT, 'credit ledger entries are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS usage_events_no_update
    BEFORE UPDATE ON usage_events
    BEGIN
      SELECT RAISE(ABORT, 'usage events are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS usage_events_no_delete
    BEFORE DELETE ON usage_events
    BEGIN
      SELECT RAISE(ABORT, 'usage events are immutable');
    END;
  `);

  db.run(`
    INSERT OR IGNORE INTO billing_plans (
      key, name, monthly_price_minor, monthly_credit_grant,
      trial_credit_grant, trial_days, overage_enabled, metadata_json
    ) VALUES
      ('free', 'Free', 0, 1000, 0, 0, 0, '{"position":1}'),
      ('pro', 'Pro', 2900, 25000, 10000, 7, 1, '{"position":2}'),
      ('team', 'Team', 9900, 100000, 0, 0, 1, '{"position":3}'),
      ('business', 'Business', 29900, 350000, 0, 0, 1, '{"position":4}'),
      ('enterprise', 'Enterprise', 0, 0, 0, 0, 1, '{"position":5,"contactSales":true}');

    INSERT OR IGNORE INTO plan_entitlements (plan_key, feature_key, enabled, quantity_limit) VALUES
      ('free', 'agents.create', 1, 2),
      ('free', 'seats', 1, 1),
      ('free', 'rag', 1, 1),
      ('free', 'voice', 0, 0),
      ('free', 'api', 0, 0),
      ('free', 'publishing', 0, 0),
      ('pro', 'agents.create', 1, 20),
      ('pro', 'seats', 1, 1),
      ('pro', 'rag', 1, NULL),
      ('pro', 'voice', 1, NULL),
      ('pro', 'api', 1, NULL),
      ('pro', 'publishing', 1, NULL),
      ('pro', 'source.export', 1, NULL),
      ('team', 'agents.create', 1, 100),
      ('team', 'seats', 1, 10),
      ('team', 'rag', 1, NULL),
      ('team', 'voice', 1, NULL),
      ('team', 'api', 1, NULL),
      ('team', 'publishing', 1, NULL),
      ('team', 'source.export', 1, NULL),
      ('team', 'audit', 1, NULL),
      ('business', 'agents.create', 1, 500),
      ('business', 'seats', 1, 50),
      ('business', 'rag', 1, NULL),
      ('business', 'voice', 1, NULL),
      ('business', 'api', 1, NULL),
      ('business', 'publishing', 1, NULL),
      ('business', 'source.export', 1, NULL),
      ('business', 'audit', 1, NULL),
      ('business', 'sso', 1, NULL),
      ('business', 'retention.controls', 1, NULL),
      ('enterprise', 'agents.create', 1, NULL),
      ('enterprise', 'seats', 1, NULL),
      ('enterprise', 'rag', 1, NULL),
      ('enterprise', 'voice', 1, NULL),
      ('enterprise', 'api', 1, NULL),
      ('enterprise', 'publishing', 1, NULL),
      ('enterprise', 'source.export', 1, NULL),
      ('enterprise', 'audit', 1, NULL),
      ('enterprise', 'sso', 1, NULL),
      ('enterprise', 'retention.controls', 1, NULL),
      ('enterprise', 'private.deployment', 1, NULL);

    INSERT OR IGNORE INTO workspace_subscriptions (
      workspace_id, plan_key, state, period_starts_at
    )
    SELECT id, 'free', 'active', CURRENT_TIMESTAMP
    FROM workspaces;

    INSERT OR IGNORE INTO credit_accounts (workspace_id)
    SELECT id FROM workspaces;
  `);
}

function ensureColumn(
  db: DatabaseAdapter,
  tableName: string,
  columnName: string,
  definition: string,
): void {
  const columns = db.query<{ name: string }>(`PRAGMA table_info(${tableName});`);
  if (columns.some((column) => column.name === columnName)) {
    return;
  }

  db.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition};`);
}

function backfillDefaultWorkspace(db: DatabaseAdapter): void {
  db.run(`
    UPDATE agents
    SET workspace_id = ${DEFAULT_WORKSPACE_ID}
    WHERE workspace_id IS NULL;

    UPDATE runs
    SET workspace_id = ${DEFAULT_WORKSPACE_ID}
    WHERE workspace_id IS NULL;

    UPDATE documents
    SET workspace_id = ${DEFAULT_WORKSPACE_ID}
    WHERE workspace_id IS NULL;

    UPDATE provider_configs
    SET workspace_id = ${DEFAULT_WORKSPACE_ID}
    WHERE workspace_id IS NULL;
  `);
}
