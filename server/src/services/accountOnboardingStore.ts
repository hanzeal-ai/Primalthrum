import { type Awaitable } from './storeTypes';

export interface AccountOnboardingRecord {
  workspaceId: number;
  ownerUserId: number;
  selectedPlanKey: 'free' | 'pro';
  state: 'pending_email' | 'active';
  activatedAt: string | null;
}

export interface AccountOnboardingStore {
  create(
    workspaceId: number,
    ownerUserId: number,
    planKey: 'free' | 'pro',
  ): Awaitable<AccountOnboardingRecord>;
  findForUser(userId: number): Awaitable<AccountOnboardingRecord | null>;
  activate(workspaceId: number, activatedAt: string): Awaitable<void>;
}
