import { type Awaitable } from './storeTypes';
import { type WorkspaceMembershipRecord } from './workspaceRepository';

export type WorkspaceOwnershipTransferErrorCode =
  | 'CURRENT_OWNER_REQUIRED'
  | 'TARGET_MEMBER_NOT_FOUND'
  | 'TARGET_MEMBER_INVALID'
  | 'TARGET_CONFIRMATION_MISMATCH'
  | 'TRANSFER_CONFLICT';

export class WorkspaceOwnershipTransferError extends Error {
  constructor(
    public readonly code: WorkspaceOwnershipTransferErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceOwnershipTransferError';
  }
}

export interface WorkspaceOwnershipTransferRecord {
  eventId: string;
  workspaceId: number;
  previousOwner: WorkspaceMembershipRecord;
  newOwner: WorkspaceMembershipRecord;
  transferredAt: string;
}

export interface TransferWorkspaceOwnershipInput {
  workspaceId: number;
  currentOwnerUserId: number;
  targetUserId: unknown;
  confirmedTargetEmail: unknown;
}

export interface WorkspaceOwnershipStore {
  transfer(input: TransferWorkspaceOwnershipInput): Awaitable<WorkspaceOwnershipTransferRecord>;
}
