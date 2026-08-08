import {
  type AccountDeletionBlocker,
  type AccountPrivacyRequestRecord,
} from './accountPrivacyRepository';
import { type Awaitable } from './storeTypes';

export interface AccountDeletionState {
  deletion: AccountPrivacyRequestRecord | null;
  blockers: AccountDeletionBlocker[];
  gracePeriodDays: number;
  requests: AccountPrivacyRequestRecord[];
}

export interface AccountDeletionStore {
  state(userId: number): Awaitable<AccountDeletionState>;
  request(userId: number, workspaceId: number): Awaitable<AccountPrivacyRequestRecord>;
  cancel(userId: number): Awaitable<AccountPrivacyRequestRecord>;
  execute(requestId: string): Awaitable<Record<string, unknown>>;
}
