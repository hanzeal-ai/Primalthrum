import { createHash } from 'node:crypto';

import {
  type AsyncDatabaseAdapter,
  type AsyncDatabaseSession,
} from '../db/asyncAdapter';
import { databaseTimestamp, nullableDatabaseTimestamp } from '../db/databaseTimestamp';
import { type AgentConfig, type AgentRecord } from './agentRepository';
import {
  type AgentDeploymentRecord,
  type AgentVersionRecord,
  type DeploymentEnvironment,
} from './agentVersionRepository';
import { type AgentVersionMutation } from './agentVersionStore';

interface VersionRow {
  id: number;
  workspace_id: number;
  agent_id: number;
  version_number: number;
  status: 'preview' | 'published';
  config_json: string;
  source_path: string;
  checksum: string;
  created_by_user_id: number | null;
  created_at: string | Date;
  published_at: string | Date | null;
}

interface DeploymentRow {
  id: number;
  workspace_id: number;
  agent_id: number;
  version_id: number;
  environment: DeploymentEnvironment;
  status: 'active' | 'inactive';
  trigger: string;
  url_path: string;
  created_by_user_id: number | null;
  created_at: string | Date;
  activated_at: string | Date;
  deactivated_at: string | Date | null;
}

const VERSION_COLUMNS = [
  'id', 'workspace_id', 'agent_id', 'version_number', 'status', 'config_json',
  'source_path', 'checksum', 'created_by_user_id', 'created_at', 'published_at',
].join(', ');

const DEPLOYMENT_COLUMNS = [
  'id', 'workspace_id', 'agent_id', 'version_id', 'environment', 'status',
  'trigger', 'url_path', 'created_by_user_id', 'created_at', 'activated_at',
  'deactivated_at',
].join(', ');

export class AsyncAgentVersionRepository {
  constructor(private readonly database: AsyncDatabaseAdapter) {}

  createPreview(agent: AgentRecord, createdByUserId: number): Promise<AgentVersionMutation> {
    const configJson = JSON.stringify(agent.config);
    const checksum = createHash('sha256')
      .update(JSON.stringify({ config: agent.config, sourcePath: agent.path }))
      .digest('hex');
    return this.database.transaction(async (transaction) => {
      await this.lockAgent(transaction, agent);
      const versionNumber = await nextVersionNumber(transaction, agent.id);
      const rows = await transaction.query<VersionRow>({
        text: `
          INSERT INTO agent_versions (
            workspace_id, agent_id, version_number, status, config_json,
            source_path, checksum, created_by_user_id
          ) VALUES ($1, $2, $3, 'preview', $4, $5, $6, $7)
          RETURNING ${VERSION_COLUMNS};
        `,
        values: [
          agent.workspaceId,
          agent.id,
          versionNumber,
          configJson,
          agent.path,
          checksum,
          createdByUserId,
        ],
      });
      const version = rows[0] ? toVersion(rows[0]) : null;
      if (!version) throw new Error('created agent version could not be loaded');
      const deployment = await activateDeployment(
        transaction,
        agent,
        version,
        'preview',
        'preview',
        createdByUserId,
      );
      await transaction.execute({
        text: `
          UPDATE agents SET preview_version_id = $1, updated_at = CURRENT_TIMESTAMP
          WHERE id = $2 AND workspace_id = $3;
        `,
        values: [version.id, agent.id, agent.workspaceId],
      });
      return { version, deployment };
    });
  }

  publish(
    agent: AgentRecord,
    versionId: number,
    createdByUserId: number,
    trigger: 'publish' | 'rollback' = 'publish',
  ): Promise<AgentVersionMutation> {
    return this.database.transaction(async (transaction) => {
      await this.lockAgent(transaction, agent);
      const version = await findById(transaction, versionId, agent.workspaceId);
      if (!version || version.agentId !== agent.id) throw new Error('agent version not found');
      if (trigger === 'rollback' && version.status !== 'published') {
        throw new Error('only a published version can be rolled back');
      }

      const publishedRows = await transaction.query<VersionRow>({
        text: `
          UPDATE agent_versions
          SET status = 'published', published_at = COALESCE(published_at, CURRENT_TIMESTAMP)
          WHERE id = $1 AND workspace_id = $2
          RETURNING ${VERSION_COLUMNS};
        `,
        values: [version.id, agent.workspaceId],
      });
      const published = publishedRows[0] ? toVersion(publishedRows[0]) : null;
      if (!published) throw new Error('published agent version could not be loaded');
      await transaction.execute({
        text: `
          UPDATE agent_deployments
          SET status = 'inactive', deactivated_at = CURRENT_TIMESTAMP
          WHERE version_id = $1 AND agent_id = $2 AND workspace_id = $3
            AND environment = 'preview' AND status = 'active';
        `,
        values: [version.id, agent.id, agent.workspaceId],
      });
      await transaction.execute({
        text: `
          UPDATE agent_configs SET config_json = $1, updated_at = CURRENT_TIMESTAMP
          WHERE agent_id = $2;
        `,
        values: [JSON.stringify(version.config), agent.id],
      });
      await transaction.execute({
        text: `
          UPDATE agents SET
            status = 'generated', published_version_id = $1, updated_at = CURRENT_TIMESTAMP
          WHERE id = $2 AND workspace_id = $3;
        `,
        values: [version.id, agent.id, agent.workspaceId],
      });
      const deployment = await activateDeployment(
        transaction,
        agent,
        published,
        'production',
        trigger,
        createdByUserId,
      );
      return { version: published, deployment };
    });
  }

  async listVersions(agentId: number, workspaceId: number): Promise<AgentVersionRecord[]> {
    const rows = await this.database.query<VersionRow>({
      text: `
        SELECT ${VERSION_COLUMNS} FROM agent_versions
        WHERE agent_id = $1 AND workspace_id = $2 ORDER BY version_number DESC;
      `,
      values: [agentId, workspaceId],
    });
    return rows.map(toVersion);
  }

  async listDeployments(agentId: number, workspaceId: number): Promise<AgentDeploymentRecord[]> {
    const rows = await this.database.query<DeploymentRow>({
      text: `
        SELECT ${DEPLOYMENT_COLUMNS} FROM agent_deployments
        WHERE agent_id = $1 AND workspace_id = $2 ORDER BY id DESC;
      `,
      values: [agentId, workspaceId],
    });
    return rows.map(toDeployment);
  }

  findById(id: number, workspaceId: number): Promise<AgentVersionRecord | null> {
    return findById(this.database, id, workspaceId);
  }

  async resolveForRun(
    agentId: number,
    workspaceId: number,
    requestedVersionId?: number,
  ): Promise<AgentVersionRecord | null> {
    if (requestedVersionId) {
      const requested = await findById(this.database, requestedVersionId, workspaceId);
      return requested?.agentId === agentId ? requested : null;
    }
    const rows = await this.database.query<VersionRow>({
      text: `
        SELECT ${VERSION_COLUMNS} FROM agent_versions
        WHERE id = (
          SELECT published_version_id FROM agents WHERE id = $1 AND workspace_id = $2
        ) LIMIT 1;
      `,
      values: [agentId, workspaceId],
    });
    return rows[0] ? toVersion(rows[0]) : null;
  }

  private async lockAgent(
    transaction: AsyncDatabaseSession,
    agent: AgentRecord,
  ): Promise<void> {
    const rows = await transaction.query<{ id: number }>({
      text: `
        SELECT id FROM agents WHERE id = $1 AND workspace_id = $2 LIMIT 1
        ${this.database.dialect === 'postgres' ? 'FOR UPDATE' : ''};
      `,
      values: [agent.id, agent.workspaceId],
    });
    if (!rows[0]) throw new Error('agent not found');
  }
}

async function findById(
  session: AsyncDatabaseSession,
  id: number,
  workspaceId: number,
): Promise<AgentVersionRecord | null> {
  const rows = await session.query<VersionRow>({
    text: `
      SELECT ${VERSION_COLUMNS} FROM agent_versions
      WHERE id = $1 AND workspace_id = $2 LIMIT 1;
    `,
    values: [id, workspaceId],
  });
  return rows[0] ? toVersion(rows[0]) : null;
}

async function nextVersionNumber(session: AsyncDatabaseSession, agentId: number): Promise<number> {
  const rows = await session.query<{ next_version: number | string }>({
    text: `
      SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version
      FROM agent_versions WHERE agent_id = $1;
    `,
    values: [agentId],
  });
  return Number(rows[0]?.next_version ?? 1);
}

async function activateDeployment(
  session: AsyncDatabaseSession,
  agent: AgentRecord,
  version: AgentVersionRecord,
  environment: DeploymentEnvironment,
  trigger: string,
  createdByUserId: number,
): Promise<AgentDeploymentRecord> {
  await session.execute({
    text: `
      UPDATE agent_deployments
      SET status = 'inactive', deactivated_at = CURRENT_TIMESTAMP
      WHERE agent_id = $1 AND workspace_id = $2 AND environment = $3 AND status = 'active';
    `,
    values: [agent.id, agent.workspaceId, environment],
  });
  const rows = await session.query<DeploymentRow>({
    text: `
      INSERT INTO agent_deployments (
        workspace_id, agent_id, version_id, environment, status,
        trigger, url_path, created_by_user_id
      ) VALUES ($1, $2, $3, $4, 'active', $5, $6, $7)
      RETURNING ${DEPLOYMENT_COLUMNS};
    `,
    values: [
      agent.workspaceId,
      agent.id,
      version.id,
      environment,
      trigger,
      environment === 'preview'
        ? `/preview/a/${agent.slug}?version=${version.id}`
        : `/a/${agent.slug}`,
      createdByUserId,
    ],
  });
  if (!rows[0]) throw new Error('active deployment could not be loaded');
  return toDeployment(rows[0]);
}

function toVersion(row: VersionRow): AgentVersionRecord {
  return {
    id: Number(row.id),
    workspaceId: Number(row.workspace_id),
    agentId: Number(row.agent_id),
    versionNumber: Number(row.version_number),
    status: row.status,
    config: JSON.parse(row.config_json) as AgentConfig,
    sourcePath: row.source_path,
    checksum: row.checksum,
    createdByUserId: row.created_by_user_id === null ? null : Number(row.created_by_user_id),
    createdAt: databaseTimestamp(row.created_at),
    publishedAt: nullableDatabaseTimestamp(row.published_at),
  };
}

function toDeployment(row: DeploymentRow): AgentDeploymentRecord {
  return {
    id: Number(row.id),
    workspaceId: Number(row.workspace_id),
    agentId: Number(row.agent_id),
    versionId: Number(row.version_id),
    environment: row.environment,
    status: row.status,
    trigger: row.trigger,
    urlPath: row.url_path,
    createdByUserId: row.created_by_user_id === null ? null : Number(row.created_by_user_id),
    createdAt: databaseTimestamp(row.created_at),
    activatedAt: databaseTimestamp(row.activated_at),
    deactivatedAt: nullableDatabaseTimestamp(row.deactivated_at),
  };
}
