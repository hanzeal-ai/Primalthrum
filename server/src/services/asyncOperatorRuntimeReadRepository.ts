import { type AsyncDatabaseAdapter, type DatabaseParameter } from '../db/asyncAdapter';
import { databaseTimestamp, nullableDatabaseTimestamp } from '../db/databaseTimestamp';
import {
  type OperatorAgentSummary,
  type OperatorJobSummary,
} from './operatorRuntimeReadRepository';
import { type OperatorRuntimeReadStore } from './operatorRuntimeReadStore';

interface AgentRow {
  id: number;
  workspace_id: number;
  workspace_name: string;
  status: string;
  version_count: number | string;
  active_deployment_count: number | string;
  preview_version_id: number | null;
  published_version_id: number | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface JobRow {
  id: number;
  workspace_id: number;
  workspace_name: string;
  type: string;
  status: string;
  attempts: number;
  max_attempts: number;
  has_error: boolean | number;
  run_at: string | Date;
  started_at: string | Date | null;
  completed_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export class AsyncOperatorRuntimeReadRepository implements OperatorRuntimeReadStore {
  constructor(private readonly database: AsyncDatabaseAdapter) {}

  async listAgents(
    workspaceId: number | undefined,
    limit = 100,
  ): Promise<OperatorAgentSummary[]> {
    const query = scopedQuery(workspaceId, limit);
    const rows = await this.database.query<AgentRow>({
      text: `
        SELECT agent.id, agent.workspace_id, workspace.name AS workspace_name,
          agent.status,
          (SELECT COUNT(*) FROM agent_versions version WHERE version.agent_id = agent.id)
            AS version_count,
          (SELECT COUNT(*) FROM agent_deployments deployment
            WHERE deployment.agent_id = agent.id AND deployment.status = 'active')
            AS active_deployment_count,
          agent.preview_version_id, agent.published_version_id,
          agent.created_at, agent.updated_at
        FROM agents agent
        JOIN workspaces workspace ON workspace.id = agent.workspace_id
        ${workspaceId ? 'WHERE agent.workspace_id = $1' : ''}
        ORDER BY agent.updated_at DESC, agent.id DESC
        LIMIT $${query.limitParameter};
      `,
      values: query.values,
    });
    return rows.map(toAgentSummary);
  }

  async listJobs(
    workspaceId: number | undefined,
    limit = 100,
  ): Promise<OperatorJobSummary[]> {
    const query = scopedQuery(workspaceId, limit);
    const rows = await this.database.query<JobRow>({
      text: `
        SELECT job.id, job.workspace_id, workspace.name AS workspace_name,
          job.type, job.status, job.attempts, job.max_attempts,
          CASE WHEN job.error = '' THEN 0 ELSE 1 END AS has_error,
          job.run_at, job.started_at, job.completed_at, job.created_at, job.updated_at
        FROM jobs job
        JOIN workspaces workspace ON workspace.id = job.workspace_id
        ${workspaceId ? 'WHERE job.workspace_id = $1' : ''}
        ORDER BY CASE job.status WHEN 'failed' THEN 0 WHEN 'running' THEN 1 ELSE 2 END,
          job.updated_at DESC, job.id DESC
        LIMIT $${query.limitParameter};
      `,
      values: query.values,
    });
    return rows.map(toJobSummary);
  }
}

function scopedQuery(
  workspaceId: number | undefined,
  limit: number,
): { limitParameter: number; values: DatabaseParameter[] } {
  const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 200);
  return workspaceId
    ? { limitParameter: 2, values: [workspaceId, boundedLimit] }
    : { limitParameter: 1, values: [boundedLimit] };
}

function toAgentSummary(row: AgentRow): OperatorAgentSummary {
  return {
    id: Number(row.id),
    agentRef: `AGT-${String(row.id).padStart(6, '0')}`,
    workspaceId: Number(row.workspace_id),
    workspaceName: row.workspace_name,
    status: row.status,
    versionCount: Number(row.version_count),
    activeDeploymentCount: Number(row.active_deployment_count),
    previewVersionId: row.preview_version_id === null ? null : Number(row.preview_version_id),
    publishedVersionId: row.published_version_id === null
      ? null
      : Number(row.published_version_id),
    createdAt: databaseTimestamp(row.created_at),
    updatedAt: databaseTimestamp(row.updated_at),
  };
}

function toJobSummary(row: JobRow): OperatorJobSummary {
  return {
    id: Number(row.id),
    workspaceId: Number(row.workspace_id),
    workspaceName: row.workspace_name,
    type: row.type,
    status: row.status,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    hasError: row.has_error === true || Number(row.has_error) === 1,
    runAt: databaseTimestamp(row.run_at),
    startedAt: nullableDatabaseTimestamp(row.started_at),
    completedAt: nullableDatabaseTimestamp(row.completed_at),
    createdAt: databaseTimestamp(row.created_at),
    updatedAt: databaseTimestamp(row.updated_at),
  };
}
