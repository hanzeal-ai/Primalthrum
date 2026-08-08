import {
  type AsyncDatabaseAdapter,
  type AsyncDatabaseSession,
} from '../db/asyncAdapter';
import { databaseTimestamp } from '../db/databaseTimestamp';
import { AsyncBillingPlanRepository } from './asyncBillingPlanRepository';
import { BillingError, type TrialGrantRecord } from './billingTypes';

interface TrialRow {
  id: number;
  workspace_id: number;
  user_id: number;
  plan_key: string;
  credit_amount: number;
  starts_at: string | Date;
  ends_at: string | Date;
  created_at: string | Date;
}

interface DatabaseError extends Error {
  code?: string;
  constraint?: string;
}

const TRIAL_COLUMNS = [
  'id', 'workspace_id', 'user_id', 'plan_key', 'credit_amount',
  'starts_at', 'ends_at', 'created_at',
].join(', ');

export class AsyncTrialRepository {
  private readonly plans: AsyncBillingPlanRepository;

  constructor(
    private readonly database: AsyncDatabaseAdapter,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.plans = new AsyncBillingPlanRepository(database);
  }

  async activate(workspaceId: number, userId: number, planKey = 'pro'): Promise<TrialGrantRecord> {
    const plan = await this.plans.find(planKey);
    if (!plan || plan.trialDays <= 0 || plan.trialCreditGrant <= 0) {
      throw new BillingError('TRIAL_PLAN_INVALID', 'the selected plan does not offer a trial');
    }
    const now = this.now();
    const startsAt = now.toISOString();
    const endsAt = new Date(now.getTime() + plan.trialDays * 86_400_000).toISOString();
    try {
      return await this.database.transaction(async (session) => {
        await this.lockWorkspace(session, workspaceId);
        await ensureBaseline(session, workspaceId);
        const workspaceTrial = await findForWorkspace(session, workspaceId);
        if (workspaceTrial) {
          if (workspaceTrial.userId === userId && workspaceTrial.planKey === planKey) {
            return workspaceTrial;
          }
          throw trialNotEligible();
        }
        const userTrials = await session.query<{ id: number }>({
          text: 'SELECT id FROM trial_grants WHERE user_id = $1 LIMIT 1;',
          values: [userId],
        });
        if (userTrials[0]) throw trialNotEligible();
        const rows = await session.query<TrialRow>({
          text: `
            INSERT INTO trial_grants (
              workspace_id, user_id, plan_key, credit_amount, starts_at, ends_at
            ) VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING ${TRIAL_COLUMNS};
          `,
          values: [workspaceId, userId, planKey, plan.trialCreditGrant, startsAt, endsAt],
        });
        const trial = rows[0];
        if (!trial) throw new Error('trial grant could not be loaded');
        await session.execute({
          text: `
            INSERT INTO credit_ledger_entries (
              workspace_id, idempotency_key, event_type, available_delta,
              source_type, source_ref
            )
            SELECT $1, $2, 'grant',
              CASE WHEN $3 > available_credits THEN $3 - available_credits ELSE 0 END,
              'trial', $4
            FROM credit_accounts WHERE workspace_id = $1
            ON CONFLICT(workspace_id, idempotency_key) DO NOTHING;
          `,
          values: [workspaceId, `trial:${workspaceId}:${userId}`, plan.trialCreditGrant, String(trial.id)],
        });
        const updated = await session.execute({
          text: `
            UPDATE workspace_subscriptions
            SET plan_key = $2, state = 'trialing', period_starts_at = $3,
              period_ends_at = $4, trial_ends_at = $4,
              cancel_at_period_end = FALSE, updated_at = CURRENT_TIMESTAMP
            WHERE workspace_id = $1;
          `,
          values: [workspaceId, planKey, startsAt, endsAt],
        });
        if (updated.rowCount !== 1) throw new Error('trial subscription was not updated');
        return toTrial(trial);
      });
    } catch (error) {
      if (error instanceof BillingError) throw error;
      if (isTrialUniqueConflict(error)) throw trialNotEligible();
      throw error;
    }
  }

  private async lockWorkspace(
    session: AsyncDatabaseSession,
    workspaceId: number,
  ): Promise<void> {
    if (this.database.dialect !== 'postgres') return;
    await session.query({
      text: 'SELECT pg_advisory_xact_lock($1);',
      values: [workspaceId],
    });
  }
}

async function findForWorkspace(
  session: AsyncDatabaseSession,
  workspaceId: number,
): Promise<TrialGrantRecord | null> {
  const rows = await session.query<TrialRow>({
    text: `SELECT ${TRIAL_COLUMNS} FROM trial_grants WHERE workspace_id = $1 LIMIT 1;`,
    values: [workspaceId],
  });
  return rows[0] ? toTrial(rows[0]) : null;
}

function toTrial(row: TrialRow): TrialGrantRecord {
  return {
    id: Number(row.id),
    workspaceId: Number(row.workspace_id),
    userId: Number(row.user_id),
    planKey: row.plan_key,
    creditAmount: Number(row.credit_amount),
    startsAt: databaseTimestamp(row.starts_at),
    endsAt: databaseTimestamp(row.ends_at),
    createdAt: databaseTimestamp(row.created_at),
  };
}

async function ensureBaseline(
  session: AsyncDatabaseSession,
  workspaceId: number,
): Promise<void> {
  await session.execute({
    text: `
      INSERT INTO workspace_subscriptions (
        workspace_id, plan_key, state, period_starts_at
      ) VALUES ($1, 'free', 'active', CURRENT_TIMESTAMP)
      ON CONFLICT(workspace_id) DO NOTHING;
    `,
    values: [workspaceId],
  });
  await session.execute({
    text: `
      INSERT INTO credit_accounts (workspace_id) VALUES ($1)
      ON CONFLICT(workspace_id) DO NOTHING;
    `,
    values: [workspaceId],
  });
  await session.execute({
    text: `
      INSERT INTO credit_ledger_entries (
        workspace_id, idempotency_key, event_type, available_delta,
        source_type, source_ref
      )
      SELECT $1, $2, 'grant', monthly_credit_grant, 'plan', 'free:initial'
      FROM billing_plans WHERE key = 'free'
      ON CONFLICT(workspace_id, idempotency_key) DO NOTHING;
    `,
    values: [workspaceId, `plan-period:free:${workspaceId}:initial`],
  });
}

function trialNotEligible(): BillingError {
  return new BillingError(
    'TRIAL_NOT_ELIGIBLE',
    'this account or workspace already used a trial',
  );
}

function isTrialUniqueConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const databaseError = error as DatabaseError;
  return databaseError.code === '23505'
    || /UNIQUE constraint failed: trial_grants\.(workspace_id|user_id)/i.test(error.message);
}
