import { type AsyncDatabaseAdapter, type DatabaseParameter } from '../db/asyncAdapter';
import { type AccountDataExport } from './accountDataExportService';
import { type AccountDataExportStore } from './accountDataExportStore';
import { type AccountPrivacyStore } from './accountPrivacyStore';
import { type DocumentFileStorage } from './fileStorage';

export class AsyncAccountDataExportService implements AccountDataExportStore {
  constructor(
    private readonly database: AsyncDatabaseAdapter,
    private readonly storage: DocumentFileStorage,
    private readonly privacy: AccountPrivacyStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async exportAccount(userId: number): Promise<AccountDataExport> {
    const result: AccountDataExport = {
      format: 'primalthrum-account-data',
      version: 1,
      generatedAt: this.now().toISOString(),
      scope: 'account',
      account: await this.accountData(userId),
    };
    await this.privacy.recordExport(userId, 'account', null);
    return result;
  }

  async exportWorkspace(userId: number, workspaceId: number): Promise<AccountDataExport> {
    const membership = await this.database.query<{ role: string }>({
      text: `
        SELECT membership.role FROM workspace_memberships membership
        JOIN workspaces workspace ON workspace.id = membership.workspace_id
        WHERE membership.user_id = $1 AND membership.workspace_id = $2
          AND membership.status = 'active' AND membership.role = 'owner'
          AND workspace.deleted_at IS NULL LIMIT 1;
      `,
      values: [userId, workspaceId],
    });
    if (!membership[0]) throw new Error('workspace owner access is required for data export');
    const result: AccountDataExport = {
      format: 'primalthrum-account-data',
      version: 1,
      generatedAt: this.now().toISOString(),
      scope: 'workspace',
      account: await this.accountData(userId),
      workspace: await this.workspaceData(workspaceId),
    };
    await this.privacy.recordExport(userId, 'workspace', workspaceId);
    return result;
  }

  private async accountData(userId: number): Promise<Record<string, unknown>> {
    const [profiles, memberships, sessions, factors, mfaEvents, emails, requests] = await Promise.all([
      this.rows(`SELECT id, email, role, email_verified_at, created_at, updated_at
        FROM users WHERE id = $1 AND deleted_at IS NULL LIMIT 1;`, [userId]),
      this.rows(`SELECT membership.id, membership.workspace_id, workspace.name AS workspace_name,
        workspace.slug AS workspace_slug, membership.role, membership.status,
        membership.created_at, membership.updated_at
        FROM workspace_memberships membership JOIN workspaces workspace
          ON workspace.id = membership.workspace_id
        WHERE membership.user_id = $1 ORDER BY membership.id ASC;`, [userId]),
      this.rows(`SELECT id, workspace_id, active_workspace_id, expires_at, revoked_at,
        authentication_method, mfa_authenticated_at, last_seen_at, created_at
        FROM sessions WHERE user_id = $1 ORDER BY id ASC;`, [userId]),
      this.rows(`SELECT state, enabled_at, created_at, updated_at
        FROM user_mfa_factors WHERE user_id = $1;`, [userId]),
      this.rows(`SELECT event_type, metadata_json, created_at
        FROM user_mfa_events WHERE user_id = $1 ORDER BY id ASC;`, [userId]),
      this.rows(`SELECT template, recipient_email, status, attempts, provider,
        accepted_at, delivered_at, dead_lettered_at, last_provider_status,
        created_at, updated_at FROM account_email_outbox
        WHERE user_id = $1 ORDER BY id ASC;`, [userId]),
      this.rows(`SELECT request_id, request_type, scope, status, scheduled_for,
        completed_at, cancelled_at, failure_reason, created_at, updated_at
        FROM account_privacy_requests WHERE user_id = $1 ORDER BY id ASC;`, [userId]),
    ]);
    if (!profiles[0]) throw new Error('account not found');
    return {
      profile: profiles[0], memberships, sessions,
      mfa: { factor: factors[0] ?? null, events: mfaEvents },
      emailHistory: emails, privacyRequests: requests,
    };
  }

  private async workspaceData(workspaceId: number): Promise<Record<string, unknown>> {
    const query = (text: string) => this.rows(text, [workspaceId]);
    const [metadata, members, agents, configs, versions, deployments, conversations,
      messages, documentRows, documentIndex, runs, streamEvents, toolAudit, providers,
      apiKeys, subscriptions, invoices, refunds, usageEvents, ratedUsageEvents,
      ledgerEntries, retentionPolicies, retentionEvents] = await Promise.all([
      query('SELECT id, name, slug, created_at, updated_at FROM workspaces WHERE id = $1 AND deleted_at IS NULL LIMIT 1;'),
      query(`SELECT membership.id, membership.user_id, users.email, membership.role,
        membership.status, membership.created_at, membership.updated_at
        FROM workspace_memberships membership JOIN users ON users.id = membership.user_id
        WHERE membership.workspace_id = $1 ORDER BY membership.id ASC;`),
      query('SELECT id, name, slug, description, status, created_at, updated_at FROM agents WHERE workspace_id = $1 ORDER BY id ASC;'),
      query(`SELECT config.id, config.agent_id, config.config_json, config.created_at, config.updated_at
        FROM agent_configs config JOIN agents ON agents.id = config.agent_id
        WHERE agents.workspace_id = $1 ORDER BY config.id ASC;`),
      query(`SELECT version.* FROM agent_versions version JOIN agents ON agents.id = version.agent_id
        WHERE agents.workspace_id = $1 ORDER BY version.id ASC;`),
      query(`SELECT deployment.* FROM agent_deployments deployment JOIN agents ON agents.id = deployment.agent_id
        WHERE agents.workspace_id = $1 ORDER BY deployment.id ASC;`),
      query('SELECT * FROM conversations WHERE workspace_id = $1 ORDER BY id ASC;'),
      query('SELECT * FROM conversation_messages WHERE workspace_id = $1 ORDER BY id ASC;'),
      query(`SELECT id, agent_id, filename, hash, status, collection, storage_ref,
        mime_type, size_bytes, created_at FROM documents WHERE workspace_id = $1 ORDER BY id ASC;`),
      query(`SELECT id, agent_id, document_id, chunk_id, text, embedding_provider,
        embedding_model, vector_store, created_at FROM document_index_entries
        WHERE workspace_id = $1 ORDER BY id ASC;`),
      query('SELECT * FROM runs WHERE workspace_id = $1 ORDER BY id ASC;'),
      query(`SELECT event.* FROM stream_events event JOIN runs ON runs.id = event.run_id
        WHERE runs.workspace_id = $1 ORDER BY event.id ASC;`),
      query('SELECT * FROM tool_audit_logs WHERE workspace_id = $1 ORDER BY id ASC;'),
      query('SELECT id, name, type, config_json, created_at FROM provider_configs WHERE workspace_id = $1 ORDER BY id ASC;'),
      query(`SELECT id, name, key_prefix, scopes_json, created_by_user_id, expires_at,
        last_used_at, last_used_method, last_used_path, revoked_at, created_at, updated_at
        FROM workspace_api_keys WHERE workspace_id = $1 ORDER BY id ASC;`),
      query('SELECT * FROM workspace_subscriptions WHERE workspace_id = $1;'),
      query('SELECT * FROM billing_invoices WHERE workspace_id = $1 ORDER BY id ASC;'),
      query('SELECT * FROM billing_refunds WHERE workspace_id = $1 ORDER BY id ASC;'),
      query('SELECT * FROM usage_events WHERE workspace_id = $1 ORDER BY id ASC;'),
      query('SELECT * FROM rated_usage_events WHERE workspace_id = $1 ORDER BY id ASC;'),
      query('SELECT * FROM credit_ledger_entries WHERE workspace_id = $1 ORDER BY id ASC;'),
      query('SELECT * FROM workspace_retention_policies WHERE workspace_id = $1;'),
      query('SELECT * FROM retention_events WHERE workspace_id = $1 ORDER BY id ASC;'),
    ]);
    if (!metadata[0]) throw new Error('workspace not found');
    const documents = await Promise.all(documentRows.map(async (document) => ({
      ...document,
      content: await readDocument(this.storage, String(document.storage_ref ?? '')),
    })));
    return {
      metadata: metadata[0], members, agents, agentConfigs: configs,
      agentVersions: versions, agentDeployments: deployments, conversations,
      messages, documents, documentIndex, runs, streamEvents, toolAudit, providers,
      apiKeys,
      billing: {
        subscription: subscriptions[0] ?? null, invoices, refunds,
        usageEvents, ratedUsageEvents, ledgerEntries,
      },
      retention: { policy: retentionPolicies[0] ?? null, events: retentionEvents },
    };
  }

  private async rows(
    text: string,
    values: readonly DatabaseParameter[],
  ): Promise<Array<Record<string, unknown>>> {
    const rows = await this.database.query<Record<string, unknown>>({ text, values });
    return rows.map(sanitizeRow);
  }
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
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === 'object') return sanitizeRow(value as Record<string, unknown>);
  return value;
}

async function readDocument(storage: DocumentFileStorage, storageRef: string): Promise<string | null> {
  if (!storageRef) return null;
  try { return await storage.read(storageRef); } catch { return null; }
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return [
    'password', 'passwordhash', 'token', 'tokenhash', 'secret', 'secretref',
    'authorization', 'cookie', 'ciphertext', 'authtag', 'codehash', 'apikey',
  ].includes(normalized);
}
