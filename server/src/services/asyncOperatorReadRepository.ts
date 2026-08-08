import { type AsyncDatabaseAdapter, type DatabaseParameter } from '../db/asyncAdapter';
import { databaseTimestamp } from '../db/databaseTimestamp';
import { type SupportGrantPermission } from './operatorAuthorization';
import {
  type OperatorOverview,
  type OperatorWorkspaceSummary,
} from './operatorReadRepository';
import { type OperatorReadStore } from './operatorReadStore';

interface OverviewRow {
  workspaces: number | string;
  users: number | string;
  active_subscriptions: number | string;
  agents: number | string;
  failed_jobs: number | string;
  failed_payments: number | string;
  abuse_enforcements: number | string;
  active_support_grants: number | string;
  monthly_credits: number | string;
  monthly_provider_cost_micros: number | string;
}

interface WorkspaceSummaryRow {
  id: number;
  name: string;
  slug: string;
  member_count: number | string;
  agent_count: number | string;
  failed_job_count: number | string;
  plan_key: string;
  subscription_state: string;
  period_credits: number | string;
  period_provider_cost_micros: number | string;
  created_at: string | Date;
}

export class AsyncOperatorReadRepository implements OperatorReadStore {
  constructor(
    private readonly database: AsyncDatabaseAdapter,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async overview(): Promise<OperatorOverview> {
    const now = this.now();
    const rows = await this.database.query<OverviewRow>({
      text: `
        SELECT
          (SELECT COUNT(*) FROM workspaces) AS workspaces,
          (SELECT COUNT(*) FROM users) AS users,
          (SELECT COUNT(*) FROM workspace_subscriptions
            WHERE state IN ('active', 'trialing')) AS active_subscriptions,
          (SELECT COUNT(*) FROM agents) AS agents,
          (SELECT COUNT(*) FROM jobs WHERE status = 'failed') AS failed_jobs,
          (SELECT COUNT(*) FROM payment_webhook_events WHERE status = 'failed') AS failed_payments,
          (SELECT COUNT(*) FROM abuse_enforcement_events) AS abuse_enforcements,
          (SELECT COUNT(*) FROM operator_support_grants
            WHERE revoked_at IS NULL AND expires_at > $1) AS active_support_grants,
          (SELECT COALESCE(SUM(credits_charged), 0) FROM rated_usage_events
            WHERE occurred_at >= $2) AS monthly_credits,
          (SELECT COALESCE(SUM(provider_cost_micros), 0) FROM rated_usage_events
            WHERE occurred_at >= $2) AS monthly_provider_cost_micros;
      `,
      values: [now.toISOString(), monthStartIso(now)],
    });
    const row = rows[0];
    if (!row) throw new Error('operator overview could not be loaded');
    return {
      workspaces: Number(row.workspaces),
      users: Number(row.users),
      activeSubscriptions: Number(row.active_subscriptions),
      agents: Number(row.agents),
      failedJobs: Number(row.failed_jobs),
      failedPayments: Number(row.failed_payments),
      abuseEnforcements: Number(row.abuse_enforcements),
      activeSupportGrants: Number(row.active_support_grants),
      monthlyCredits: Number(row.monthly_credits),
      monthlyProviderCostMicros: Number(row.monthly_provider_cost_micros),
    };
  }

  async listWorkspaces(limit = 100): Promise<OperatorWorkspaceSummary[]> {
    return this.workspaceRows(undefined, limit);
  }

  async workspace(id: number): Promise<OperatorWorkspaceSummary | null> {
    const rows = await this.workspaceRows(id, 1);
    return rows[0] ?? null;
  }

  async supportContext(
    workspaceId: number,
    permissions: SupportGrantPermission[],
  ): Promise<Record<string, unknown> | null> {
    const workspace = await this.workspace(workspaceId);
    if (!workspace) return null;
    const context: Record<string, unknown> = {
      workspace: {
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        memberCount: workspace.memberCount,
        createdAt: workspace.createdAt,
      },
    };
    if (permissions.includes('workspace.agents.read')) {
      context.agents = { count: workspace.agentCount };
    }
    if (permissions.includes('workspace.jobs.read')) {
      context.jobs = { failedCount: workspace.failedJobCount };
    }
    if (permissions.includes('workspace.billing.read')) {
      context.billing = {
        planKey: workspace.planKey,
        subscriptionState: workspace.subscriptionState,
        periodCredits: workspace.periodCredits,
        periodProviderCostMicros: workspace.periodProviderCostMicros,
      };
    }
    return context;
  }

  private async workspaceRows(
    workspaceId: number | undefined,
    limit: number,
  ): Promise<OperatorWorkspaceSummary[]> {
    const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 200);
    const values: DatabaseParameter[] = workspaceId
      ? [monthStartIso(this.now()), workspaceId, boundedLimit]
      : [monthStartIso(this.now()), boundedLimit];
    const rows = await this.database.query<WorkspaceSummaryRow>({
      text: `
        SELECT w.id, w.name, w.slug,
          (SELECT COUNT(*) FROM workspace_memberships membership
            WHERE membership.workspace_id = w.id AND membership.status = 'active') AS member_count,
          (SELECT COUNT(*) FROM agents agent WHERE agent.workspace_id = w.id) AS agent_count,
          (SELECT COUNT(*) FROM jobs job
            WHERE job.workspace_id = w.id AND job.status = 'failed') AS failed_job_count,
          COALESCE((SELECT subscription.plan_key FROM workspace_subscriptions subscription
            WHERE subscription.workspace_id = w.id), 'free') AS plan_key,
          COALESCE((SELECT subscription.state FROM workspace_subscriptions subscription
            WHERE subscription.workspace_id = w.id), 'active') AS subscription_state,
          COALESCE((SELECT SUM(usage.credits_charged) FROM rated_usage_events usage
            WHERE usage.workspace_id = w.id AND usage.occurred_at >= $1), 0) AS period_credits,
          COALESCE((SELECT SUM(usage.provider_cost_micros) FROM rated_usage_events usage
            WHERE usage.workspace_id = w.id AND usage.occurred_at >= $1), 0)
            AS period_provider_cost_micros,
          w.created_at
        FROM workspaces w
        ${workspaceId ? 'WHERE w.id = $2' : ''}
        ORDER BY w.id DESC LIMIT $${workspaceId ? 3 : 2};
      `,
      values,
    });
    return rows.map(toWorkspaceSummary);
  }
}

function monthStartIso(value: Date): string {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1)).toISOString();
}

function toWorkspaceSummary(row: WorkspaceSummaryRow): OperatorWorkspaceSummary {
  return {
    id: Number(row.id),
    name: row.name,
    slug: row.slug,
    memberCount: Number(row.member_count),
    agentCount: Number(row.agent_count),
    failedJobCount: Number(row.failed_job_count),
    planKey: row.plan_key,
    subscriptionState: row.subscription_state,
    periodCredits: Number(row.period_credits),
    periodProviderCostMicros: Number(row.period_provider_cost_micros),
    createdAt: databaseTimestamp(row.created_at),
  };
}
