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
