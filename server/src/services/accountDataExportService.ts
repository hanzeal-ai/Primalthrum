import { type DocumentFileStorage } from './fileStorage';
import { AccountPrivacyRepository, type AccountPrivacyScope } from './accountPrivacyRepository';
import { SqliteDatabase, sqlValue } from '../db/sqlite';

export interface AccountDataExport {
  format: 'primalthrum-account-data';
  version: 1;
  generatedAt: string;
  scope: AccountPrivacyScope;
  account: Record<string, unknown>;
  workspace?: Record<string, unknown>;
}

export class AccountDataExportService {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly storage: DocumentFileStorage,
    private readonly privacy: AccountPrivacyRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  exportAccount(userId: number): AccountDataExport {
    const generatedAt = this.now().toISOString();
    const result: AccountDataExport = {
      format: 'primalthrum-account-data',
      version: 1,
      generatedAt,
      scope: 'account',
      account: this.accountData(userId),
    };
    this.privacy.recordExport(userId, 'account', null);
    return result;
  }

  async exportWorkspace(userId: number, workspaceId: number): Promise<AccountDataExport> {
    const membership = this.db.query<{ role: string }>(`
      SELECT membership.role
      FROM workspace_memberships membership
      JOIN workspaces workspace ON workspace.id = membership.workspace_id
      WHERE membership.user_id = ${sqlValue(userId)}
        AND membership.workspace_id = ${sqlValue(workspaceId)}
        AND membership.status = 'active' AND membership.role = 'owner'
        AND workspace.deleted_at IS NULL
      LIMIT 1;
    `)[0];
    if (!membership) throw new Error('workspace owner access is required for data export');

    const generatedAt = this.now().toISOString();
    const result: AccountDataExport = {
      format: 'primalthrum-account-data',
      version: 1,
      generatedAt,
      scope: 'workspace',
      account: this.accountData(userId),
      workspace: await this.workspaceData(workspaceId),
    };
    this.privacy.recordExport(userId, 'workspace', workspaceId);
    return result;
  }

  private accountData(userId: number): Record<string, unknown> {
    const profile = this.db.query<Record<string, unknown>>(`
      SELECT id, email, role, email_verified_at, created_at, updated_at
      FROM users WHERE id = ${sqlValue(userId)} AND deleted_at IS NULL LIMIT 1;
    `)[0];
    if (!profile) throw new Error('account not found');
    return {
      profile,
      memberships: rows(this.db, `
        SELECT membership.id, membership.workspace_id, workspace.name AS workspace_name,
          workspace.slug AS workspace_slug, membership.role, membership.status,
          membership.created_at, membership.updated_at
        FROM workspace_memberships membership
        JOIN workspaces workspace ON workspace.id = membership.workspace_id
        WHERE membership.user_id = ${sqlValue(userId)}
        ORDER BY membership.id ASC;
      `),
      sessions: rows(this.db, `
        SELECT id, workspace_id, active_workspace_id, expires_at, revoked_at,
          authentication_method, mfa_authenticated_at, last_seen_at, created_at
        FROM sessions WHERE user_id = ${sqlValue(userId)} ORDER BY id ASC;
      `),
      mfa: {
        factor: rows(this.db, `
          SELECT state, enabled_at, created_at, updated_at
          FROM user_mfa_factors WHERE user_id = ${sqlValue(userId)};
        `)[0] ?? null,
        events: rows(this.db, `
          SELECT event_type, metadata_json, created_at
          FROM user_mfa_events WHERE user_id = ${sqlValue(userId)} ORDER BY id ASC;
        `),
      },
      emailHistory: rows(this.db, `
        SELECT template, recipient_email, status, attempts, provider,
          accepted_at, delivered_at, dead_lettered_at, last_provider_status,
          created_at, updated_at
        FROM account_email_outbox WHERE user_id = ${sqlValue(userId)} ORDER BY id ASC;
      `),
      privacyRequests: rows(this.db, `
        SELECT request_id, request_type, scope, status, scheduled_for,
          completed_at, cancelled_at, failure_reason, created_at, updated_at
        FROM account_privacy_requests WHERE user_id = ${sqlValue(userId)} ORDER BY id ASC;
      `),
    };
  }

  private async workspaceData(workspaceId: number): Promise<Record<string, unknown>> {
    const workspace = rows(this.db, `
      SELECT id, name, slug, created_at, updated_at
      FROM workspaces WHERE id = ${sqlValue(workspaceId)} AND deleted_at IS NULL LIMIT 1;
    `)[0];
    if (!workspace) throw new Error('workspace not found');

    const documents = await Promise.all(rows(this.db, `
      SELECT id, agent_id, filename, hash, status, collection, storage_ref,
        mime_type, size_bytes, created_at
      FROM documents WHERE workspace_id = ${sqlValue(workspaceId)} ORDER BY id ASC;
    `).map(async (document) => ({
      ...document,
      content: await readDocument(this.storage, String(document.storage_ref ?? '')),
    })));

    return {
      metadata: workspace,
      members: rows(this.db, `
        SELECT membership.id, membership.user_id, users.email, membership.role,
          membership.status, membership.created_at, membership.updated_at
        FROM workspace_memberships membership
        JOIN users ON users.id = membership.user_id
        WHERE membership.workspace_id = ${sqlValue(workspaceId)} ORDER BY membership.id ASC;
      `),
      agents: rows(this.db, `
        SELECT id, name, slug, description, status, created_at, updated_at
        FROM agents WHERE workspace_id = ${sqlValue(workspaceId)} ORDER BY id ASC;
      `),
      agentConfigs: rows(this.db, `
        SELECT config.id, config.agent_id, config.config_json, config.created_at, config.updated_at
        FROM agent_configs config
        JOIN agents ON agents.id = config.agent_id
        WHERE agents.workspace_id = ${sqlValue(workspaceId)} ORDER BY config.id ASC;
      `),
      agentVersions: rows(this.db, `
        SELECT version.* FROM agent_versions version
        JOIN agents ON agents.id = version.agent_id
        WHERE agents.workspace_id = ${sqlValue(workspaceId)} ORDER BY version.id ASC;
      `),
      agentDeployments: rows(this.db, `
        SELECT deployment.* FROM agent_deployments deployment
        JOIN agents ON agents.id = deployment.agent_id
        WHERE agents.workspace_id = ${sqlValue(workspaceId)} ORDER BY deployment.id ASC;
      `),
      conversations: rows(this.db, `
        SELECT * FROM conversations WHERE workspace_id = ${sqlValue(workspaceId)} ORDER BY id ASC;
      `),
      messages: rows(this.db, `
        SELECT * FROM conversation_messages
        WHERE workspace_id = ${sqlValue(workspaceId)} ORDER BY id ASC;
      `),
      documents,
      documentIndex: rows(this.db, `
        SELECT id, agent_id, document_id, chunk_id, text, embedding_provider,
          embedding_model, vector_store, created_at
        FROM document_index_entries
        WHERE workspace_id = ${sqlValue(workspaceId)} ORDER BY id ASC;
      `),
      runs: rows(this.db, `
        SELECT * FROM runs WHERE workspace_id = ${sqlValue(workspaceId)} ORDER BY id ASC;
      `),
      streamEvents: rows(this.db, `
        SELECT event.* FROM stream_events event
        JOIN runs ON runs.id = event.run_id
        WHERE runs.workspace_id = ${sqlValue(workspaceId)} ORDER BY event.id ASC;
      `),
      toolAudit: rows(this.db, `
        SELECT * FROM tool_audit_logs
        WHERE workspace_id = ${sqlValue(workspaceId)} ORDER BY id ASC;
      `),
      providers: rows(this.db, `
        SELECT id, name, type, config_json, created_at
        FROM provider_configs WHERE workspace_id = ${sqlValue(workspaceId)} ORDER BY id ASC;
      `),
      apiKeys: rows(this.db, `
        SELECT id, name, key_prefix, scopes_json, created_by_user_id, expires_at,
          last_used_at, last_used_method, last_used_path, revoked_at, created_at, updated_at
        FROM workspace_api_keys WHERE workspace_id = ${sqlValue(workspaceId)} ORDER BY id ASC;
      `),
      billing: {
        subscription: rows(this.db, `
          SELECT * FROM workspace_subscriptions WHERE workspace_id = ${sqlValue(workspaceId)};
        `)[0] ?? null,
        invoices: rows(this.db, `
          SELECT * FROM billing_invoices WHERE workspace_id = ${sqlValue(workspaceId)} ORDER BY id ASC;
        `),
        refunds: rows(this.db, `
          SELECT * FROM billing_refunds WHERE workspace_id = ${sqlValue(workspaceId)} ORDER BY id ASC;
        `),
        usageEvents: rows(this.db, `
          SELECT * FROM usage_events WHERE workspace_id = ${sqlValue(workspaceId)} ORDER BY id ASC;
        `),
        ratedUsageEvents: rows(this.db, `
          SELECT * FROM rated_usage_events WHERE workspace_id = ${sqlValue(workspaceId)} ORDER BY id ASC;
        `),
        ledgerEntries: rows(this.db, `
          SELECT * FROM credit_ledger_entries WHERE workspace_id = ${sqlValue(workspaceId)} ORDER BY id ASC;
        `),
      },
      retention: {
        policy: rows(this.db, `
          SELECT * FROM workspace_retention_policies WHERE workspace_id = ${sqlValue(workspaceId)};
        `)[0] ?? null,
        events: rows(this.db, `
          SELECT * FROM retention_events WHERE workspace_id = ${sqlValue(workspaceId)} ORDER BY id ASC;
        `),
      },
    };
  }
}

function rows(db: SqliteDatabase, query: string): Array<Record<string, unknown>> {
  return db.query<Record<string, unknown>>(query).map((row) => sanitizeRow(row));
}

function sanitizeRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (isSensitiveKey(key)) return [key, '[REDACTED]'];
    if (key.endsWith('_json') && typeof value === 'string') {
      try {
        return [key.slice(0, -5), sanitizeValue(JSON.parse(value))];
      } catch {
        return [key, '[INVALID_JSON]'];
      }
    }
    return [key, sanitizeValue(value)];
  }));
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === 'object') return sanitizeRow(value as Record<string, unknown>);
  return value;
}

async function readDocument(
  storage: DocumentFileStorage,
  storageRef: string,
): Promise<string | null> {
  if (!storageRef) return null;
  try {
    return await storage.read(storageRef);
  } catch {
    return null;
  }
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return [
    'password', 'passwordhash', 'token', 'tokenhash', 'secret', 'secretref',
    'authorization', 'cookie', 'ciphertext', 'authtag', 'codehash', 'apikey',
  ].includes(normalized);
}
