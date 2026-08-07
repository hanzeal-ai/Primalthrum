import { initializeSchema } from '../db/schema';
import { type DatabaseAdapter } from '../db/adapter';
import { sqlValue } from '../db/sql';
import { type SupportGrantPermission } from './operatorAuthorization';

export interface OperatorOverview {
  workspaces: number;
  users: number;
  activeSubscriptions: number;
  agents: number;
  failedJobs: number;
  failedPayments: number;
  abuseEnforcements: number;
  activeSupportGrants: number;
  monthlyCredits: number;
  monthlyProviderCostMicros: number;
}

export interface OperatorWorkspaceSummary {
  id: number;
  name: string;
  slug: string;
  memberCount: number;
  agentCount: number;
  failedJobCount: number;
  planKey: string;
  subscriptionState: string;
  periodCredits: number;
  periodProviderCostMicros: number;
  createdAt: string;
}

interface WorkspaceSummaryRow {
  id: number;
  name: string;
  slug: string;
  member_count: number;
  agent_count: number;
  failed_job_count: number;
  plan_key: string;
  subscription_state: string;
  period_credits: number;
  period_provider_cost_micros: number;
  created_at: string;
}

export class OperatorReadRepository {
  constructor(
    private readonly db: DatabaseAdapter,
    private readonly now: () => Date = () => new Date(),
  ) {
    initializeSchema(db);
  }

  overview(): OperatorOverview {
    const monthStart = monthStartIso(this.now());
    return {
      workspaces: this.count('workspaces'),
      users: this.count('users'),
      activeSubscriptions: Number(this.db.query<{ count: number }>(`
        SELECT COUNT(*) AS count FROM workspace_subscriptions
        WHERE state IN ('active', 'trialing');
      `)[0]?.count ?? 0),
      agents: this.count('agents'),
      failedJobs: Number(this.db.query<{ count: number }>(`
        SELECT COUNT(*) AS count FROM jobs WHERE status = 'failed';
      `)[0]?.count ?? 0),
      failedPayments: Number(this.db.query<{ count: number }>(`
        SELECT COUNT(*) AS count FROM payment_webhook_events WHERE status = 'failed';
      `)[0]?.count ?? 0),
      abuseEnforcements: this.count('abuse_enforcement_events'),
      activeSupportGrants: Number(this.db.query<{ count: number }>(`
        SELECT COUNT(*) AS count FROM operator_support_grants
        WHERE revoked_at IS NULL AND expires_at > ${sqlValue(this.now().toISOString())};
      `)[0]?.count ?? 0),
      monthlyCredits: Number(this.db.query<{ total: number }>(`
        SELECT COALESCE(SUM(credits_charged), 0) AS total FROM rated_usage_events
        WHERE occurred_at >= ${sqlValue(monthStart)};
      `)[0]?.total ?? 0),
      monthlyProviderCostMicros: Number(this.db.query<{ total: number }>(`
        SELECT COALESCE(SUM(provider_cost_micros), 0) AS total FROM rated_usage_events
        WHERE occurred_at >= ${sqlValue(monthStart)};
      `)[0]?.total ?? 0),
    };
  }

  listWorkspaces(limit = 100): OperatorWorkspaceSummary[] {
    const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 200);
    return this.workspaceRows('', boundedLimit).map(toWorkspaceSummary);
  }

  workspace(id: number): OperatorWorkspaceSummary | null {
    const row = this.workspaceRows(`WHERE w.id = ${sqlValue(id)}`, 1)[0];
    return row ? toWorkspaceSummary(row) : null;
  }

  supportContext(
    workspaceId: number,
    permissions: SupportGrantPermission[],
  ): Record<string, unknown> | null {
    const workspace = this.workspace(workspaceId);
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

  private count(table: string): number {
    const allowed = new Set(['workspaces', 'users', 'agents', 'abuse_enforcement_events']);
    if (!allowed.has(table)) throw new Error('operator count table is invalid');
    return Number(this.db.query<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${table};`,
    )[0]?.count ?? 0);
  }

  private workspaceRows(where: string, limit: number): WorkspaceSummaryRow[] {
    const monthStart = monthStartIso(this.now());
    return this.db.query<WorkspaceSummaryRow>(`
      SELECT
        w.id,
        w.name,
        w.slug,
        (SELECT COUNT(*) FROM workspace_memberships m
          WHERE m.workspace_id = w.id AND m.status = 'active') AS member_count,
        (SELECT COUNT(*) FROM agents a WHERE a.workspace_id = w.id) AS agent_count,
        (SELECT COUNT(*) FROM jobs j
          WHERE j.workspace_id = w.id AND j.status = 'failed') AS failed_job_count,
        COALESCE((SELECT s.plan_key FROM workspace_subscriptions s
          WHERE s.workspace_id = w.id), 'free') AS plan_key,
        COALESCE((SELECT s.state FROM workspace_subscriptions s
          WHERE s.workspace_id = w.id), 'active') AS subscription_state,
        COALESCE((SELECT SUM(u.credits_charged) FROM rated_usage_events u
          WHERE u.workspace_id = w.id AND u.occurred_at >= ${sqlValue(monthStart)}), 0)
          AS period_credits,
        COALESCE((SELECT SUM(u.provider_cost_micros) FROM rated_usage_events u
          WHERE u.workspace_id = w.id AND u.occurred_at >= ${sqlValue(monthStart)}), 0)
          AS period_provider_cost_micros,
        w.created_at
      FROM workspaces w
      ${where}
      ORDER BY w.id DESC
      LIMIT ${limit};
    `);
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
    createdAt: row.created_at,
  };
}
