import {
  type AccountDeletionBlocker,
  type AccountPrivacyRequestRecord,
  type AccountPrivacyScope,
} from './accountPrivacyRepository';
import { type Awaitable } from './storeTypes';

export interface AccountPrivacyStore {
  recordExport(
    userId: number,
    scope: AccountPrivacyScope,
    workspaceId: number | null,
  ): Awaitable<AccountPrivacyRequestRecord>;
  requestDeletion(
    userId: number,
    workspaceId: number,
    scheduledFor: string,
  ): Awaitable<AccountPrivacyRequestRecord>;
  cancelDeletion(userId: number): Awaitable<AccountPrivacyRequestRecord>;
  beginDeletion(requestId: string): Awaitable<AccountPrivacyRequestRecord>;
  completeDeletion(
    requestId: string,
    metadata: Record<string, unknown>,
  ): Awaitable<AccountPrivacyRequestRecord>;
  recordDeletionFailure(requestId: string, error: unknown): Awaitable<AccountPrivacyRequestRecord>;
  activeDeletion(userId: number): Awaitable<AccountPrivacyRequestRecord | null>;
  findByRequestId(requestId: string): Awaitable<AccountPrivacyRequestRecord | null>;
  listForUser(userId: number, limit?: number): Awaitable<AccountPrivacyRequestRecord[]>;
  dueDeletions(): Awaitable<AccountPrivacyRequestRecord[]>;
  deletionBlockers(userId: number): Awaitable<AccountDeletionBlocker[]>;
  ownedSingleMemberWorkspaceIds(userId: number): Awaitable<number[]>;
}
