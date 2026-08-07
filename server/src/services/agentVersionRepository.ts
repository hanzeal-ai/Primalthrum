import { createHash } from 'node:crypto';

import { initializeSchema } from '../db/schema';
import { type DatabaseAdapter } from '../db/adapter';
import { sqlValue } from '../db/sql';
import { type AgentConfig, type AgentRecord } from './agentRepository';

export type AgentVersionStatus = 'preview' | 'published';
export type DeploymentEnvironment = 'preview' | 'production';

export interface AgentVersionRecord {
  id: number;
  workspaceId: number;
  agentId: number;
  versionNumber: number;
  status: AgentVersionStatus;
  config: AgentConfig;
  sourcePath: string;
  checksum: string;
  createdByUserId: number | null;
  createdAt: string;
  publishedAt: string | null;
}

export interface AgentDeploymentRecord {
  id: number;
  workspaceId: number;
  agentId: number;
  versionId: number;
  environment: DeploymentEnvironment;
  status: 'active' | 'inactive';
  trigger: string;
  urlPath: string;
  createdByUserId: number | null;
  createdAt: string;
  activatedAt: string;
  deactivatedAt: string | null;
}

interface VersionRow {
  id: number;
  workspace_id: number;
  agent_id: number;
  version_number: number;
  status: AgentVersionStatus;
  config_json: string;
  source_path: string;
  checksum: string;
  created_by_user_id: number | null;
  created_at: string;
  published_at: string | null;
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
  created_at: string;
  activated_at: string;
  deactivated_at: string | null;
}

export class AgentVersionRepository {
  constructor(private readonly db: DatabaseAdapter) {
    initializeSchema(db);
  }

  createPreview(agent: AgentRecord, createdByUserId: number): {
    version: AgentVersionRecord;
    deployment: AgentDeploymentRecord;
  } {
    const versionNumber = this.nextVersionNumber(agent.id);
    const configJson = JSON.stringify(agent.config);
    const checksum = createHash('sha256')
      .update(JSON.stringify({ config: agent.config, sourcePath: agent.path }))
      .digest('hex');
    this.db.run(`
      INSERT INTO agent_versions (
        workspace_id,
        agent_id,
        version_number,
        status,
        config_json,
        source_path,
        checksum,
        created_by_user_id
      ) VALUES (
        ${sqlValue(agent.workspaceId)},
        ${sqlValue(agent.id)},
        ${sqlValue(versionNumber)},
        'preview',
        ${sqlValue(configJson)},
        ${sqlValue(agent.path)},
        ${sqlValue(checksum)},
        ${sqlValue(createdByUserId)}
      );
    `);
    const version = this.findByAgentVersionNumber(
      agent.id,
      versionNumber,
      agent.workspaceId,
    );
    if (!version) throw new Error('created agent version could not be loaded');
    const deployment = this.activateDeployment(
      agent,
      version,
      'preview',
      'preview',
      createdByUserId,
    );
    this.db.run(`
      UPDATE agents
      SET preview_version_id = ${sqlValue(version.id)}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ${sqlValue(agent.id)} AND workspace_id = ${sqlValue(agent.workspaceId)};
    `);
    return { version, deployment };
  }

  publish(
    agent: AgentRecord,
    versionId: number,
    createdByUserId: number,
    trigger: 'publish' | 'rollback' = 'publish',
  ): { version: AgentVersionRecord; deployment: AgentDeploymentRecord } {
    const version = this.findById(versionId, agent.workspaceId);
    if (!version || version.agentId !== agent.id) throw new Error('agent version not found');
    if (trigger === 'rollback' && version.status !== 'published') {
      throw new Error('only a published version can be rolled back');
    }

    this.db.run(`
      UPDATE agent_versions
      SET
        status = 'published',
        published_at = COALESCE(published_at, CURRENT_TIMESTAMP)
      WHERE id = ${sqlValue(version.id)} AND workspace_id = ${sqlValue(agent.workspaceId)};

      UPDATE agent_deployments
      SET status = 'inactive', deactivated_at = CURRENT_TIMESTAMP
      WHERE version_id = ${sqlValue(version.id)}
        AND environment = 'preview'
        AND status = 'active';

      UPDATE agent_configs
      SET config_json = ${sqlValue(JSON.stringify(version.config))}, updated_at = CURRENT_TIMESTAMP
      WHERE agent_id = ${sqlValue(agent.id)};

      UPDATE agents
      SET
        status = 'generated',
        published_version_id = ${sqlValue(version.id)},
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${sqlValue(agent.id)} AND workspace_id = ${sqlValue(agent.workspaceId)};
    `);
    const published = this.findById(version.id, agent.workspaceId);
    if (!published) throw new Error('published agent version could not be loaded');
    const deployment = this.activateDeployment(
      agent,
      published,
      'production',
      trigger,
      createdByUserId,
    );
    return { version: published, deployment };
  }

  listVersions(agentId: number, workspaceId: number): AgentVersionRecord[] {
    return this.db.query<VersionRow>(`
      SELECT ${VERSION_COLUMNS}
      FROM agent_versions
      WHERE agent_id = ${sqlValue(agentId)} AND workspace_id = ${sqlValue(workspaceId)}
      ORDER BY version_number DESC;
    `).map(toVersion);
  }

  listDeployments(agentId: number, workspaceId: number): AgentDeploymentRecord[] {
    return this.db.query<DeploymentRow>(`
      SELECT ${DEPLOYMENT_COLUMNS}
      FROM agent_deployments
      WHERE agent_id = ${sqlValue(agentId)} AND workspace_id = ${sqlValue(workspaceId)}
      ORDER BY id DESC;
    `).map(toDeployment);
  }

  findById(id: number, workspaceId: number): AgentVersionRecord | null {
    const rows = this.db.query<VersionRow>(`
      SELECT ${VERSION_COLUMNS}
      FROM agent_versions
      WHERE id = ${sqlValue(id)} AND workspace_id = ${sqlValue(workspaceId)}
      LIMIT 1;
    `);
    return rows[0] ? toVersion(rows[0]) : null;
  }

  resolveForRun(
    agentId: number,
    workspaceId: number,
    requestedVersionId?: number,
  ): AgentVersionRecord | null {
    if (requestedVersionId) {
      const requested = this.findById(requestedVersionId, workspaceId);
      return requested?.agentId === agentId ? requested : null;
    }
    const rows = this.db.query<VersionRow>(`
      SELECT ${VERSION_COLUMNS}
      FROM agent_versions
      WHERE id = (
        SELECT published_version_id
        FROM agents
        WHERE id = ${sqlValue(agentId)}
          AND workspace_id = ${sqlValue(workspaceId)}
      )
      LIMIT 1;
    `);
    return rows[0] ? toVersion(rows[0]) : null;
  }

  private findByAgentVersionNumber(
    agentId: number,
    versionNumber: number,
    workspaceId: number,
  ): AgentVersionRecord | null {
    const rows = this.db.query<VersionRow>(`
      SELECT ${VERSION_COLUMNS}
      FROM agent_versions
      WHERE agent_id = ${sqlValue(agentId)}
        AND version_number = ${sqlValue(versionNumber)}
        AND workspace_id = ${sqlValue(workspaceId)}
      LIMIT 1;
    `);
    return rows[0] ? toVersion(rows[0]) : null;
  }

  private nextVersionNumber(agentId: number): number {
    const rows = this.db.query<{ next_version: number }>(`
      SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version
      FROM agent_versions
      WHERE agent_id = ${sqlValue(agentId)};
    `);
    return Number(rows[0]?.next_version ?? 1);
  }

  private activateDeployment(
    agent: AgentRecord,
    version: AgentVersionRecord,
    environment: DeploymentEnvironment,
    trigger: string,
    createdByUserId: number,
  ): AgentDeploymentRecord {
    this.db.run(`
      UPDATE agent_deployments
      SET status = 'inactive', deactivated_at = CURRENT_TIMESTAMP
      WHERE agent_id = ${sqlValue(agent.id)}
        AND workspace_id = ${sqlValue(agent.workspaceId)}
        AND environment = ${sqlValue(environment)}
        AND status = 'active';

      INSERT INTO agent_deployments (
        workspace_id,
        agent_id,
        version_id,
        environment,
        status,
        trigger,
        url_path,
        created_by_user_id
      ) VALUES (
        ${sqlValue(agent.workspaceId)},
        ${sqlValue(agent.id)},
        ${sqlValue(version.id)},
        ${sqlValue(environment)},
        'active',
        ${sqlValue(trigger)},
        ${sqlValue(environment === 'preview'
          ? `/preview/a/${agent.slug}?version=${version.id}`
          : `/a/${agent.slug}`)},
        ${sqlValue(createdByUserId)}
      );
    `);
    const rows = this.db.query<DeploymentRow>(`
      SELECT ${DEPLOYMENT_COLUMNS}
      FROM agent_deployments
      WHERE agent_id = ${sqlValue(agent.id)}
        AND environment = ${sqlValue(environment)}
        AND status = 'active'
      ORDER BY id DESC
      LIMIT 1;
    `);
    if (!rows[0]) throw new Error('active deployment could not be loaded');
    return toDeployment(rows[0]);
  }
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
    createdAt: row.created_at,
    publishedAt: row.published_at,
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
    createdAt: row.created_at,
    activatedAt: row.activated_at,
    deactivatedAt: row.deactivated_at,
  };
}
