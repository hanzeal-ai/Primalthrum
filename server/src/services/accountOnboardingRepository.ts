import { initializeSchema } from '../db/schema';
import { type DatabaseAdapter } from '../db/adapter';
import { sqlValue } from '../db/sql';

export interface AccountOnboardingRecord {
  workspaceId: number;
  ownerUserId: number;
  selectedPlanKey: 'free' | 'pro';
  state: 'pending_email' | 'active';
  activatedAt: string | null;
}

export class AccountOnboardingRepository {
  constructor(private readonly db: DatabaseAdapter) {
    initializeSchema(db);
  }

  create(workspaceId: number, ownerUserId: number, planKey: 'free' | 'pro'): AccountOnboardingRecord {
    this.db.run(`
      INSERT INTO workspace_onboarding (
        workspace_id, owner_user_id, selected_plan_key, state
      ) VALUES (
        ${sqlValue(workspaceId)}, ${sqlValue(ownerUserId)}, ${sqlValue(planKey)}, 'pending_email'
      );
    `);
    const created = this.findForUser(ownerUserId);
    if (!created) throw new Error('account onboarding could not be loaded');
    return created;
  }

  findForUser(userId: number): AccountOnboardingRecord | null {
    const row = this.db.query<{
      workspace_id: number;
      owner_user_id: number;
      selected_plan_key: 'free' | 'pro';
      state: 'pending_email' | 'active';
      activated_at: string | null;
    }>(`
      SELECT workspace_id, owner_user_id, selected_plan_key, state, activated_at
      FROM workspace_onboarding WHERE owner_user_id = ${sqlValue(userId)} LIMIT 1;
    `)[0];
    return row ? {
      workspaceId: Number(row.workspace_id),
      ownerUserId: Number(row.owner_user_id),
      selectedPlanKey: row.selected_plan_key,
      state: row.state,
      activatedAt: row.activated_at,
    } : null;
  }

  activate(workspaceId: number, activatedAt: string): void {
    this.db.run(`
      UPDATE workspace_onboarding SET state = 'active', activated_at = ${sqlValue(activatedAt)},
        updated_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ${sqlValue(workspaceId)};
    `);
  }
}
