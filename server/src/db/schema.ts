import { SqliteDatabase } from './sqlite';
import {
  DEFAULT_WORKSPACE_ID,
  DEFAULT_WORKSPACE_NAME,
  DEFAULT_WORKSPACE_SLUG,
} from './workspaceDefaults';

export function initializeSchema(db: SqliteDatabase): void {
  db.run(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS workspaces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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

    INSERT OR IGNORE INTO workspaces (id, name, slug)
    VALUES (
      ${DEFAULT_WORKSPACE_ID},
      '${DEFAULT_WORKSPACE_NAME}',
      '${DEFAULT_WORKSPACE_SLUG}'
    );

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

  const defaultWorkspaceColumn = `INTEGER NOT NULL DEFAULT ${DEFAULT_WORKSPACE_ID}`;
  ensureColumn(db, 'agents', 'workspace_id', defaultWorkspaceColumn);
  ensureColumn(db, 'runs', 'workspace_id', defaultWorkspaceColumn);
  ensureColumn(db, 'documents', 'workspace_id', defaultWorkspaceColumn);
  ensureColumn(db, 'provider_configs', 'workspace_id', defaultWorkspaceColumn);
  backfillDefaultWorkspace(db);
}

function ensureColumn(
  db: SqliteDatabase,
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

function backfillDefaultWorkspace(db: SqliteDatabase): void {
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
