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
  {
    id: '016_payment_lifecycle',
    up: applyPaymentLifecycle,
  },
  {
    id: '017_usage_rating_cost_controls',
    up: applyUsageRatingCostControls,
  },
  {
    id: '018_usage_meter_export_outbox',
    up: applyUsageMeterExportOutbox,
  },
  {
    id: '019_account_identity_lifecycle',
    up: applyAccountIdentityLifecycle,
  },
  {
    id: '020_privacy_consent_analytics',
    up: applyPrivacyConsentAnalytics,
  },
  {
    id: '021_transactional_email_delivery',
    up: applyTransactionalEmailDelivery,
  },
  {
    id: '022_abuse_protection',
    up: applyAbuseProtection,
  },
  {
    id: '023_api_keys_security',
    up: applyApiKeysSecurity,
  },
  {
    id: '024_workspace_retention',
    up: applyWorkspaceRetention,
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

function applyPaymentLifecycle(db: DatabaseAdapter): void {
  ensureColumn(db, 'workspace_subscriptions', 'provider_price_ref', `TEXT NOT NULL DEFAULT ''`);
  ensureColumn(db, 'workspace_subscriptions', 'provider_subscription_item_ref', `TEXT NOT NULL DEFAULT ''`);
  ensureColumn(db, 'workspace_subscriptions', 'pending_plan_key', `TEXT NOT NULL DEFAULT ''`);
  ensureColumn(db, 'workspace_subscriptions', 'grace_ends_at', 'TEXT');
  ensureColumn(db, 'workspace_subscriptions', 'canceled_at', 'TEXT');
  ensureColumn(db, 'workspace_subscriptions', 'latest_provider_event_created', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'workspace_subscriptions', 'latest_provider_event_ref', `TEXT NOT NULL DEFAULT ''`);

  db.run(`
    CREATE TABLE IF NOT EXISTS payment_prices (
      provider TEXT NOT NULL,
      plan_key TEXT NOT NULL,
      provider_price_ref TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(provider, plan_key),
      UNIQUE(provider, provider_price_ref),
      FOREIGN KEY(plan_key) REFERENCES billing_plans(key) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS payment_customers (
      workspace_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      provider_customer_ref TEXT NOT NULL,
      email TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(workspace_id, provider),
      UNIQUE(provider, provider_customer_ref),
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS payment_checkout_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      provider_session_ref TEXT NOT NULL,
      plan_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      checkout_url TEXT NOT NULL DEFAULT '',
      created_by_user_id INTEGER NOT NULL,
      expires_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(workspace_id, provider, idempotency_key),
      UNIQUE(provider, provider_session_ref),
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
      FOREIGN KEY(plan_key) REFERENCES billing_plans(key)
    );

    CREATE TABLE IF NOT EXISTS payment_webhook_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      provider_event_ref TEXT NOT NULL,
      event_type TEXT NOT NULL,
      livemode INTEGER NOT NULL DEFAULT 0,
      api_version TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL,
      signature_timestamp INTEGER,
      object_created_at INTEGER NOT NULL DEFAULT 0,
      workspace_id INTEGER,
      status TEXT NOT NULL DEFAULT 'received',
      attempts INTEGER NOT NULL DEFAULT 1,
      error TEXT NOT NULL DEFAULT '',
      received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      processed_at TEXT,
      UNIQUE(provider, provider_event_ref),
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS billing_invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      provider_invoice_ref TEXT NOT NULL,
      provider_customer_ref TEXT NOT NULL DEFAULT '',
      provider_subscription_ref TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'usd',
      amount_due_minor INTEGER NOT NULL DEFAULT 0,
      amount_paid_minor INTEGER NOT NULL DEFAULT 0,
      amount_refunded_minor INTEGER NOT NULL DEFAULT 0,
      period_starts_at TEXT,
      period_ends_at TEXT,
      hosted_invoice_url TEXT NOT NULL DEFAULT '',
      invoice_pdf_url TEXT NOT NULL DEFAULT '',
      due_at TEXT,
      paid_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(provider, provider_invoice_ref),
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS billing_refunds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      provider_refund_ref TEXT NOT NULL,
      provider_payment_ref TEXT NOT NULL DEFAULT '',
      provider_invoice_ref TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      amount_minor INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'usd',
      reason TEXT NOT NULL DEFAULT '',
      provider_created_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(provider, provider_refund_ref),
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS subscription_state_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      provider_event_ref TEXT NOT NULL,
      from_state TEXT NOT NULL,
      to_state TEXT NOT NULL,
      plan_key TEXT NOT NULL,
      effective_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(provider, provider_event_ref),
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(plan_key) REFERENCES billing_plans(key)
    );

    CREATE INDEX IF NOT EXISTS payment_webhook_events_status_idx
      ON payment_webhook_events(status, received_at);
    CREATE INDEX IF NOT EXISTS billing_invoices_workspace_idx
      ON billing_invoices(workspace_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS billing_refunds_workspace_idx
      ON billing_refunds(workspace_id, created_at DESC);
  `);
}

function applyUsageRatingCostControls(db: DatabaseAdapter): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS pricing_versions (
      key TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      effective_from TEXT NOT NULL,
      effective_to TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS meter_prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pricing_version_key TEXT NOT NULL,
      meter TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT '*',
      model TEXT NOT NULL DEFAULT '*',
      unit_size INTEGER NOT NULL CHECK(unit_size > 0),
      credits_per_unit INTEGER NOT NULL CHECK(credits_per_unit >= 0),
      provider_cost_micros_per_unit INTEGER NOT NULL DEFAULT 0
        CHECK(provider_cost_micros_per_unit >= 0),
      active INTEGER NOT NULL DEFAULT 1,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(pricing_version_key, meter, provider, model),
      FOREIGN KEY(pricing_version_key) REFERENCES pricing_versions(key)
    );

    CREATE TABLE IF NOT EXISTS rated_usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL,
      meter TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      quantity INTEGER NOT NULL CHECK(quantity >= 0),
      billable_units INTEGER NOT NULL CHECK(billable_units >= 0),
      credits_charged INTEGER NOT NULL CHECK(credits_charged >= 0),
      provider_cost_micros INTEGER NOT NULL DEFAULT 0 CHECK(provider_cost_micros >= 0),
      meter_price_id INTEGER NOT NULL,
      resource_type TEXT NOT NULL DEFAULT '',
      resource_id TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(workspace_id, idempotency_key),
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(meter_price_id) REFERENCES meter_prices(id)
    );

    CREATE TABLE IF NOT EXISTS workspace_cost_controls (
      workspace_id INTEGER PRIMARY KEY,
      monthly_credit_limit INTEGER CHECK(monthly_credit_limit IS NULL OR monthly_credit_limit >= 0),
      monthly_provider_cost_micros_limit INTEGER
        CHECK(monthly_provider_cost_micros_limit IS NULL OR monthly_provider_cost_micros_limit >= 0),
      hard_limit INTEGER NOT NULL DEFAULT 1,
      overage_enabled INTEGER NOT NULL DEFAULT 0,
      alert_thresholds_json TEXT NOT NULL DEFAULT '[50,80,100]',
      updated_by_user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(updated_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS cost_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      period_key TEXT NOT NULL,
      threshold_percent INTEGER NOT NULL,
      metric TEXT NOT NULL,
      current_value INTEGER NOT NULL,
      limit_value INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      delivered_at TEXT,
      UNIQUE(workspace_id, period_key, threshold_percent, metric),
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE TRIGGER IF NOT EXISTS rated_usage_events_no_update
    BEFORE UPDATE ON rated_usage_events
    BEGIN
      SELECT RAISE(ABORT, 'rated usage events are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS rated_usage_events_no_delete
    BEFORE DELETE ON rated_usage_events
    BEGIN
      SELECT RAISE(ABORT, 'rated usage events are immutable');
    END;

    CREATE INDEX IF NOT EXISTS rated_usage_workspace_period_idx
      ON rated_usage_events(workspace_id, occurred_at, meter);
    CREATE INDEX IF NOT EXISTS rated_usage_resource_idx
      ON rated_usage_events(workspace_id, resource_type, resource_id);
  `);

  db.run(`
    INSERT OR IGNORE INTO pricing_versions (key, name, effective_from)
    VALUES ('2026-08-default', 'Initial commercial pricing', '2026-01-01T00:00:00.000Z');

    INSERT OR IGNORE INTO meter_prices (
      pricing_version_key, meter, unit_size, credits_per_unit,
      provider_cost_micros_per_unit
    ) VALUES
      ('2026-08-default', 'llm.input_tokens', 1000, 10, 1500),
      ('2026-08-default', 'llm.output_tokens', 1000, 30, 6000),
      ('2026-08-default', 'embedding.tokens', 1000, 2, 100),
      ('2026-08-default', 'speech.transcription_seconds', 60, 20, 6000),
      ('2026-08-default', 'speech.synthesis_characters', 1000, 15, 15000),
      ('2026-08-default', 'tool.calls', 1, 5, 0),
      ('2026-08-default', 'rag.retrievals', 1, 2, 0),
      ('2026-08-default', 'rag.storage_bytes', 1048576, 3, 0),
      ('2026-08-default', 'file.storage_bytes', 1048576, 2, 0),
      ('2026-08-default', 'hosted.runs', 1, 10, 0),
      ('2026-08-default', 'api.runs', 1, 10, 0);
  `);
}

function applyUsageMeterExportOutbox(db: DatabaseAdapter): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS usage_meter_exports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rated_usage_event_id INTEGER NOT NULL,
      destination TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'delivering', 'delivered', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
      next_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      delivered_at TEXT,
      UNIQUE(rated_usage_event_id, destination),
      FOREIGN KEY(rated_usage_event_id) REFERENCES rated_usage_events(id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS usage_meter_exports_dispatch_idx
      ON usage_meter_exports(destination, status, next_attempt_at, id);

    CREATE TRIGGER IF NOT EXISTS rated_usage_enqueue_meter_export
    AFTER INSERT ON rated_usage_events
    BEGIN
      INSERT OR IGNORE INTO usage_meter_exports (rated_usage_event_id, destination)
      VALUES (NEW.id, 'primary');
    END;

    INSERT OR IGNORE INTO usage_meter_exports (rated_usage_event_id, destination)
    SELECT id, 'primary' FROM rated_usage_events;
  `);
}

function applyAccountIdentityLifecycle(db: DatabaseAdapter): void {
  ensureColumn(db, 'users', 'email_verified_at', 'TEXT');
  db.run(`
    UPDATE users
    SET email_verified_at = COALESCE(email_verified_at, CURRENT_TIMESTAMP);

    CREATE TABLE IF NOT EXISTS account_action_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      purpose TEXT NOT NULL CHECK(purpose IN ('verify_email', 'reset_password')),
      token_hash TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL DEFAULT '{}',
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS account_email_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      template TEXT NOT NULL CHECK(template IN ('verify_email', 'reset_password')),
      recipient_email TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'delivering', 'delivered', 'failed', 'superseded')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
      next_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_error TEXT NOT NULL DEFAULT '',
      delivered_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS workspace_onboarding (
      workspace_id INTEGER PRIMARY KEY,
      owner_user_id INTEGER NOT NULL UNIQUE,
      selected_plan_key TEXT NOT NULL CHECK(selected_plan_key IN ('free', 'pro')),
      state TEXT NOT NULL DEFAULT 'pending_email'
        CHECK(state IN ('pending_email', 'active')),
      activated_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(owner_user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS account_action_tokens_lookup_idx
      ON account_action_tokens(purpose, token_hash, expires_at);
    CREATE INDEX IF NOT EXISTS account_email_outbox_dispatch_idx
      ON account_email_outbox(status, next_attempt_at, id);
  `);
}

function applyPrivacyConsentAnalytics(db: DatabaseAdapter): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS privacy_consent_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_id TEXT NOT NULL UNIQUE,
      subject_hash TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      necessary_granted INTEGER NOT NULL DEFAULT 1 CHECK(necessary_granted = 1),
      analytics_granted INTEGER NOT NULL CHECK(analytics_granted IN (0, 1)),
      action TEXT NOT NULL CHECK(action IN ('granted', 'denied', 'withdrawn')),
      source TEXT NOT NULL CHECK(source IN ('banner', 'preferences')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS product_analytics_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      consent_receipt_id INTEGER NOT NULL,
      subject_hash TEXT NOT NULL,
      event_name TEXT NOT NULL,
      path TEXT NOT NULL,
      properties_json TEXT NOT NULL DEFAULT '{}',
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(consent_receipt_id) REFERENCES privacy_consent_receipts(id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS privacy_consent_subject_idx
      ON privacy_consent_receipts(subject_hash, id DESC);
    CREATE INDEX IF NOT EXISTS product_analytics_name_time_idx
      ON product_analytics_events(event_name, occurred_at);

    CREATE TRIGGER IF NOT EXISTS privacy_consent_receipts_no_update
    BEFORE UPDATE ON privacy_consent_receipts
    BEGIN
      SELECT RAISE(ABORT, 'privacy consent receipts are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS privacy_consent_receipts_no_delete
    BEFORE DELETE ON privacy_consent_receipts
    BEGIN
      SELECT RAISE(ABORT, 'privacy consent receipts are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS product_analytics_events_no_update
    BEFORE UPDATE ON product_analytics_events
    BEGIN
      SELECT RAISE(ABORT, 'product analytics events are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS product_analytics_events_no_delete
    BEFORE DELETE ON product_analytics_events
    BEGIN
      SELECT RAISE(ABORT, 'product analytics events are immutable');
    END;
  `);
}

function applyTransactionalEmailDelivery(db: DatabaseAdapter): void {
  ensureColumn(db, 'account_email_outbox', 'provider', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'account_email_outbox', 'provider_message_id', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'account_email_outbox', 'accepted_at', 'TEXT');
  ensureColumn(db, 'account_email_outbox', 'dead_lettered_at', 'TEXT');
  ensureColumn(db, 'account_email_outbox', 'last_provider_status', "TEXT NOT NULL DEFAULT ''");
  db.run(`
    CREATE TABLE IF NOT EXISTS account_email_delivery_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      provider_event_id TEXT NOT NULL,
      provider_message_id TEXT NOT NULL,
      outbox_id INTEGER,
      event_type TEXT NOT NULL
        CHECK(event_type IN ('accepted', 'delivered', 'delayed', 'bounced', 'complained', 'rejected')),
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(provider, provider_event_id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS account_email_provider_message_idx
      ON account_email_outbox(provider, provider_message_id)
      WHERE provider_message_id <> '';
    CREATE INDEX IF NOT EXISTS account_email_delivery_event_message_idx
      ON account_email_delivery_events(provider, provider_message_id, id);

    CREATE TRIGGER IF NOT EXISTS account_email_delivery_events_no_update
    BEFORE UPDATE ON account_email_delivery_events
    BEGIN
      SELECT RAISE(ABORT, 'account email delivery events are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS account_email_delivery_events_no_delete
    BEFORE DELETE ON account_email_delivery_events
    BEGIN
      SELECT RAISE(ABORT, 'account email delivery events are immutable');
    END;
  `);
}

function applyAbuseProtection(db: DatabaseAdapter): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS abuse_rate_limit_buckets (
      rule_key TEXT NOT NULL,
      subject_hash TEXT NOT NULL,
      window_started_at TEXT NOT NULL,
      window_ends_at TEXT NOT NULL,
      request_count INTEGER NOT NULL DEFAULT 0 CHECK(request_count >= 0),
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(rule_key, subject_hash, window_started_at)
    );

    CREATE TABLE IF NOT EXISTS abuse_enforcement_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      rule_key TEXT NOT NULL,
      action TEXT NOT NULL,
      subject_hash TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN ('rate_limited', 'challenge_failed')),
      retry_after_seconds INTEGER NOT NULL DEFAULT 0 CHECK(retry_after_seconds >= 0),
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS abuse_challenge_grants (
      grant_hash TEXT PRIMARY KEY,
      rule_key TEXT NOT NULL,
      subject_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS abuse_rate_limit_expiry_idx
      ON abuse_rate_limit_buckets(window_ends_at);
    CREATE INDEX IF NOT EXISTS abuse_enforcement_rule_time_idx
      ON abuse_enforcement_events(rule_key, created_at);
    CREATE INDEX IF NOT EXISTS abuse_challenge_grant_expiry_idx
      ON abuse_challenge_grants(expires_at);

    CREATE TRIGGER IF NOT EXISTS abuse_enforcement_events_no_update
    BEFORE UPDATE ON abuse_enforcement_events
    BEGIN
      SELECT RAISE(ABORT, 'abuse enforcement events are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS abuse_enforcement_events_no_delete
    BEFORE DELETE ON abuse_enforcement_events
    BEGIN
      SELECT RAISE(ABORT, 'abuse enforcement events are immutable');
    END;
  `);
}

function applyApiKeysSecurity(db: DatabaseAdapter): void {
  ensureColumn(db, 'sessions', 'last_seen_at', 'TEXT');
  db.run(`
    UPDATE sessions SET last_seen_at = COALESCE(last_seen_at, created_at);

    CREATE TABLE IF NOT EXISTS workspace_api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      key_prefix TEXT NOT NULL UNIQUE,
      token_hash TEXT NOT NULL UNIQUE,
      scopes_json TEXT NOT NULL,
      created_by_user_id INTEGER,
      expires_at TEXT NOT NULL,
      last_used_at TEXT,
      last_used_method TEXT NOT NULL DEFAULT '',
      last_used_path TEXT NOT NULL DEFAULT '',
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS api_key_usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      api_key_id INTEGER NOT NULL,
      workspace_id INTEGER NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      used_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(api_key_id) REFERENCES workspace_api_keys(id) ON DELETE RESTRICT,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS workspace_api_keys_active_idx
      ON workspace_api_keys(workspace_id, revoked_at, expires_at);
    CREATE INDEX IF NOT EXISTS api_key_usage_events_key_time_idx
      ON api_key_usage_events(api_key_id, used_at DESC);

    CREATE TRIGGER IF NOT EXISTS api_key_usage_events_no_update
    BEFORE UPDATE ON api_key_usage_events
    BEGIN
      SELECT RAISE(ABORT, 'api key usage events are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS api_key_usage_events_no_delete
    BEFORE DELETE ON api_key_usage_events
    BEGIN
      SELECT RAISE(ABORT, 'api key usage events are immutable');
    END;
  `);
}

function applyWorkspaceRetention(db: DatabaseAdapter): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS workspace_retention_policies (
      workspace_id INTEGER PRIMARY KEY,
      conversation_days INTEGER CHECK(
        conversation_days IS NULL OR conversation_days BETWEEN 30 AND 3650
      ),
      run_days INTEGER CHECK(run_days IS NULL OR run_days BETWEEN 7 AND 3650),
      document_days INTEGER CHECK(
        document_days IS NULL OR document_days BETWEEN 30 AND 3650
      ),
      updated_by_user_id INTEGER,
      last_enforced_at TEXT,
      next_enforcement_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(updated_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS retention_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      event_type TEXT NOT NULL CHECK(
        event_type IN ('policy_updated', 'enforcement_completed')
      ),
      actor_user_id INTEGER,
      policy_json TEXT NOT NULL,
      result_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(actor_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS retention_file_deletions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      storage_ref TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(
        status IN ('pending', 'retrying', 'completed', 'failed')
      ),
      attempts INTEGER NOT NULL DEFAULT 0,
      error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS retained_tool_audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_audit_id INTEGER NOT NULL UNIQUE,
      workspace_id INTEGER NOT NULL,
      run_id INTEGER NOT NULL,
      event_id INTEGER NOT NULL UNIQUE,
      tool_name TEXT NOT NULL,
      status TEXT NOT NULL,
      dangerous INTEGER NOT NULL DEFAULT 0,
      node TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      archived_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS workspace_retention_due_idx
      ON workspace_retention_policies(next_enforcement_at);
    CREATE INDEX IF NOT EXISTS retention_events_workspace_time_idx
      ON retention_events(workspace_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS retention_file_deletions_status_idx
      ON retention_file_deletions(status, id);
    CREATE INDEX IF NOT EXISTS retained_tool_audit_workspace_run_idx
      ON retained_tool_audit_logs(workspace_id, run_id, id);

    CREATE TRIGGER IF NOT EXISTS retention_events_no_update
    BEFORE UPDATE ON retention_events
    BEGIN
      SELECT RAISE(ABORT, 'retention events are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS retention_events_no_delete
    BEFORE DELETE ON retention_events
    BEGIN
      SELECT RAISE(ABORT, 'retention events are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS retained_tool_audit_no_update
    BEFORE UPDATE ON retained_tool_audit_logs
    BEGIN
      SELECT RAISE(ABORT, 'retained tool audit logs are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS retained_tool_audit_no_delete
    BEFORE DELETE ON retained_tool_audit_logs
    BEGIN
      SELECT RAISE(ABORT, 'retained tool audit logs are immutable');
    END;
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
