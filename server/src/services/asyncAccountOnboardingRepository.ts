import { type AsyncDatabaseAdapter } from '../db/asyncAdapter';
import { nullableDatabaseTimestamp } from '../db/databaseTimestamp';
import {
  type AccountOnboardingRecord,
  type AccountOnboardingStore,
} from './accountOnboardingStore';

interface AccountOnboardingRow {
  workspace_id: number;
  owner_user_id: number;
  selected_plan_key: 'free' | 'pro';
  state: 'pending_email' | 'active';
  activated_at: string | Date | null;
}

const ONBOARDING_COLUMNS = [
  'workspace_id', 'owner_user_id', 'selected_plan_key', 'state', 'activated_at',
].join(', ');

export class AsyncAccountOnboardingRepository implements AccountOnboardingStore {
  constructor(private readonly database: AsyncDatabaseAdapter) {}

  async create(
    workspaceId: number,
    ownerUserId: number,
    planKey: 'free' | 'pro',
  ): Promise<AccountOnboardingRecord> {
    const rows = await this.database.query<AccountOnboardingRow>({
      text: `
        INSERT INTO workspace_onboarding (
          workspace_id, owner_user_id, selected_plan_key, state
        ) VALUES ($1, $2, $3, 'pending_email')
        RETURNING ${ONBOARDING_COLUMNS};
      `,
      values: [workspaceId, ownerUserId, planKey],
    });
    if (!rows[0]) throw new Error('account onboarding could not be loaded');
    return toAccountOnboardingRecord(rows[0]);
  }

  async findForUser(userId: number): Promise<AccountOnboardingRecord | null> {
    const rows = await this.database.query<AccountOnboardingRow>({
      text: `
        SELECT ${ONBOARDING_COLUMNS} FROM workspace_onboarding
        WHERE owner_user_id = $1 LIMIT 1;
      `,
      values: [userId],
    });
    return rows[0] ? toAccountOnboardingRecord(rows[0]) : null;
  }

  async activate(workspaceId: number, activatedAt: string): Promise<void> {
    const result = await this.database.execute({
      text: `
        UPDATE workspace_onboarding SET state = 'active', activated_at = $2,
          updated_at = CURRENT_TIMESTAMP
        WHERE workspace_id = $1;
      `,
      values: [workspaceId, activatedAt],
    });
    if (result.rowCount !== 1) throw new Error('account onboarding state is missing');
  }
}

function toAccountOnboardingRecord(row: AccountOnboardingRow): AccountOnboardingRecord {
  return {
    workspaceId: Number(row.workspace_id),
    ownerUserId: Number(row.owner_user_id),
    selectedPlanKey: row.selected_plan_key,
    state: row.state,
    activatedAt: nullableDatabaseTimestamp(row.activated_at),
  };
}
