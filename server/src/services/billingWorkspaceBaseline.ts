import { type DatabaseAdapter } from '../db/adapter';
import { sqlValue } from '../db/sql';

export function ensureBillingWorkspaceBaseline(db: DatabaseAdapter, workspaceId: number): void {
  const freeGrantKey = `plan-period:free:${workspaceId}:initial`;
  db.run(`
    BEGIN IMMEDIATE;
    INSERT OR IGNORE INTO workspace_subscriptions (
      workspace_id, plan_key, state, period_starts_at
    ) VALUES (${sqlValue(workspaceId)}, 'free', 'active', CURRENT_TIMESTAMP);
    INSERT OR IGNORE INTO credit_accounts (workspace_id)
    VALUES (${sqlValue(workspaceId)});
    INSERT OR IGNORE INTO credit_ledger_entries (
      workspace_id, idempotency_key, event_type, available_delta,
      source_type, source_ref
    )
    SELECT ${sqlValue(workspaceId)}, ${sqlValue(freeGrantKey)}, 'grant',
      monthly_credit_grant, 'plan', 'free:initial'
    FROM billing_plans
    WHERE key = 'free';
    COMMIT;
  `);
}
