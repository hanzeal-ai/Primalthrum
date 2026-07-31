import { SqliteDatabase, sqlValue } from '../db/sqlite';
import { BillingPlanRepository } from './billingPlanRepository';
import { ensureBillingWorkspaceBaseline } from './billingWorkspaceBaseline';
import { BillingError, type TrialGrantRecord } from './billingTypes';

interface TrialRow {
  id: number;
  workspace_id: number;
  user_id: number;
  plan_key: string;
  credit_amount: number;
  starts_at: string;
  ends_at: string;
  created_at: string;
}

export class TrialRepository {
  private readonly plans: BillingPlanRepository;

  constructor(
    private readonly db: SqliteDatabase,
    private readonly now: () => Date,
  ) {
    this.plans = new BillingPlanRepository(db);
  }

  activate(workspaceId: number, userId: number, planKey = 'pro'): TrialGrantRecord {
    ensureBillingWorkspaceBaseline(this.db, workspaceId);
    const plan = this.plans.find(planKey);
    if (!plan || plan.trialDays <= 0 || plan.trialCreditGrant <= 0) {
      throw new BillingError('TRIAL_PLAN_INVALID', 'the selected plan does not offer a trial');
    }
    const now = this.now();
    const startsAt = now.toISOString();
    const endsAt = new Date(now.getTime() + plan.trialDays * 86_400_000).toISOString();
    const trialLedgerKey = `trial:${workspaceId}:${userId}`;

    this.db.run(`
      BEGIN IMMEDIATE;
      INSERT INTO trial_grants (
        workspace_id, user_id, plan_key, credit_amount, starts_at, ends_at
      )
      SELECT
        ${sqlValue(workspaceId)}, ${sqlValue(userId)}, ${sqlValue(planKey)},
        ${plan.trialCreditGrant}, ${sqlValue(startsAt)}, ${sqlValue(endsAt)}
      WHERE NOT EXISTS (SELECT 1 FROM trial_grants WHERE workspace_id = ${sqlValue(workspaceId)})
        AND NOT EXISTS (SELECT 1 FROM trial_grants WHERE user_id = ${sqlValue(userId)});

      INSERT OR IGNORE INTO credit_ledger_entries (
        workspace_id, idempotency_key, event_type, available_delta,
        source_type, source_ref
      )
      SELECT
        t.workspace_id, ${sqlValue(trialLedgerKey)}, 'grant',
        MAX(0, t.credit_amount - a.available_credits), 'trial', CAST(t.id AS TEXT)
      FROM trial_grants t
      JOIN credit_accounts a ON a.workspace_id = t.workspace_id
      WHERE t.workspace_id = ${sqlValue(workspaceId)}
        AND t.user_id = ${sqlValue(userId)};

      UPDATE workspace_subscriptions
      SET plan_key = ${sqlValue(planKey)}, state = 'trialing',
          period_starts_at = ${sqlValue(startsAt)}, period_ends_at = ${sqlValue(endsAt)},
          trial_ends_at = ${sqlValue(endsAt)}, cancel_at_period_end = 0,
          updated_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ${sqlValue(workspaceId)}
        AND EXISTS (
          SELECT 1 FROM trial_grants
          WHERE workspace_id = ${sqlValue(workspaceId)} AND user_id = ${sqlValue(userId)}
        );
      COMMIT;
    `);

    const trial = this.findForWorkspace(workspaceId);
    if (!trial || trial.userId !== userId) {
      throw new BillingError('TRIAL_NOT_ELIGIBLE', 'this account or workspace already used a trial');
    }
    return trial;
  }

  private findForWorkspace(workspaceId: number): TrialGrantRecord | null {
    const row = this.db.query<TrialRow>(`
      SELECT id, workspace_id, user_id, plan_key, credit_amount,
        starts_at, ends_at, created_at
      FROM trial_grants
      WHERE workspace_id = ${sqlValue(workspaceId)}
      LIMIT 1;
    `)[0];
    return row ? {
      id: Number(row.id),
      workspaceId: Number(row.workspace_id),
      userId: Number(row.user_id),
      planKey: row.plan_key,
      creditAmount: Number(row.credit_amount),
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      createdAt: row.created_at,
    } : null;
  }
}
