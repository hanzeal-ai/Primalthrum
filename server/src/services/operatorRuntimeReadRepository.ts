import { type DatabaseAdapter } from '../db/adapter';
import { sqlValue } from '../db/sql';

export interface OperatorAgentSummary {
  id: number;
  agentRef: string;
  workspaceId: number;
  workspaceName: string;
  status: string;
  versionCount: number;
  activeDeploymentCount: number;
  previewVersionId: number | null;
  publishedVersionId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface OperatorJobSummary {
  id: number;
  workspaceId: number;
  workspaceName: string;
  type: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  hasError: boolean;
  runAt: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AgentRow {
  id: number;
  workspace_id: number;
  workspace_name: string;
  status: string;
  version_count: number;
  active_deployment_count: number;
  preview_version_id: number | null;
  published_version_id: number | null;
  created_at: string;
  updated_at: string;
}

interface JobRow {
  id: number;
  workspace_id: number;
  workspace_name: string;
  type: string;
  status: string;
  attempts: number;
  max_attempts: number;
  has_error: number;
  run_at: string;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export class OperatorRuntimeReadRepository {
  constructor(private readonly db: DatabaseAdapter) {
  }

  listAgents(workspaceId: number | undefined, limit = 100): OperatorAgentSummary[] {
    const boundedLimit = bounded(limit);
    const filter = workspaceWhere('agent.workspace_id', workspaceId);
    return this.db.query<AgentRow>(`
      SELECT
        agent.id,
        agent.workspace_id,
        workspace.name AS workspace_name,
        agent.status,
        (SELECT COUNT(*) FROM agent_versions version WHERE version.agent_id = agent.id)
          AS version_count,
        (SELECT COUNT(*) FROM agent_deployments deployment
          WHERE deployment.agent_id = agent.id AND deployment.status = 'active')
          AS active_deployment_count,
        agent.preview_version_id,
        agent.published_version_id,
        agent.created_at,
        agent.updated_at
      FROM agents agent
      JOIN workspaces workspace ON workspace.id = agent.workspace_id
      ${filter}
      ORDER BY agent.updated_at DESC, agent.id DESC
      LIMIT ${boundedLimit};
    `).map(toAgentSummary);
  }

  listJobs(workspaceId: number | undefined, limit = 100): OperatorJobSummary[] {
    const boundedLimit = bounded(limit);
    const filter = workspaceWhere('job.workspace_id', workspaceId);
    return this.db.query<JobRow>(`
      SELECT
        job.id,
        job.workspace_id,
        workspace.name AS workspace_name,
        job.type,
        job.status,
        job.attempts,
        job.max_attempts,
        CASE WHEN job.error = '' THEN 0 ELSE 1 END AS has_error,
        job.run_at,
        job.started_at,
        job.completed_at,
        job.created_at,
        job.updated_at
      FROM jobs job
      JOIN workspaces workspace ON workspace.id = job.workspace_id
      ${filter}
      ORDER BY
        CASE job.status WHEN 'failed' THEN 0 WHEN 'running' THEN 1 ELSE 2 END,
        job.updated_at DESC,
        job.id DESC
      LIMIT ${boundedLimit};
    `).map(toJobSummary);
  }
}

function bounded(limit: number): number {
  return Math.min(Math.max(Math.floor(limit), 1), 200);
}

function workspaceWhere(column: string, workspaceId: number | undefined): string {
  return workspaceId ? `WHERE ${column} = ${sqlValue(workspaceId)}` : '';
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
    hasError: Boolean(row.has_error),
    runAt: row.run_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
