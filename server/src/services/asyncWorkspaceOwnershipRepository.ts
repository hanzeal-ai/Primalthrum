import { randomUUID } from 'node:crypto';

import { type AsyncDatabaseAdapter } from '../db/asyncAdapter';
import { databaseTimestamp } from '../db/databaseTimestamp';
import { normalizeEmail } from './userRepository';
import {
  type WorkspaceMembershipRecord,
  type WorkspaceRole,
} from './workspaceRepository';
import {
  type TransferWorkspaceOwnershipInput,
  type WorkspaceOwnershipStore,
  type WorkspaceOwnershipTransferRecord,
  WorkspaceOwnershipTransferError,
} from './workspaceOwnershipStore';

interface MembershipRow {
  id: number;
  workspace_id: number;
  user_id: number;
  email: string;
  role: WorkspaceRole;
  status: string;
  created_at: string | Date;
  updated_at: string | Date;
}

export class AsyncWorkspaceOwnershipRepository implements WorkspaceOwnershipStore {
  constructor(private readonly database: AsyncDatabaseAdapter) {}

  transfer(input: TransferWorkspaceOwnershipInput): Promise<WorkspaceOwnershipTransferRecord> {
    const targetUserId = positiveInteger(input.targetUserId, 'targetUserId');
    const confirmedTargetEmail = normalizeEmail(input.confirmedTargetEmail);
    const eventId = randomUUID();
    return this.database.transaction(async (session) => {
      const rows = await session.query<MembershipRow>({
        text: `
          SELECT m.id, m.workspace_id, m.user_id, u.email, m.role, m.status,
            m.created_at, m.updated_at
          FROM workspace_memberships m JOIN users u ON u.id = m.user_id
          WHERE m.workspace_id = $1 AND m.user_id IN ($2, $3)
          ORDER BY m.user_id
          ${this.database.dialect === 'postgres' ? 'FOR UPDATE' : ''};
        `,
        values: [input.workspaceId, input.currentOwnerUserId, targetUserId],
      });
      const currentOwner = rows.find((row) => Number(row.user_id) === input.currentOwnerUserId);
      const target = rows.find((row) => Number(row.user_id) === targetUserId);
      validateMemberships(currentOwner, target, confirmedTargetEmail);
      if (!currentOwner || !target) throw new Error('validated ownership members are missing');

      const events = await session.query<{ created_at: string | Date }>({
        text: `
          INSERT INTO workspace_ownership_events (
            event_id, workspace_id, previous_owner_user_id,
            new_owner_user_id, initiated_by_user_id
          ) VALUES ($1, $2, $3, $4, $3)
          RETURNING created_at;
        `,
        values: [eventId, input.workspaceId, currentOwner.user_id, target.user_id],
      });
      const previousUpdate = await session.execute({
        text: `
          UPDATE workspace_memberships SET role = 'admin', updated_at = CURRENT_TIMESTAMP
          WHERE workspace_id = $1 AND user_id = $2 AND role = 'owner' AND status = 'active';
        `,
        values: [input.workspaceId, currentOwner.user_id],
      });
      const targetUpdate = await session.execute({
        text: `
          UPDATE workspace_memberships SET role = 'owner', updated_at = CURRENT_TIMESTAMP
          WHERE workspace_id = $1 AND user_id = $2 AND role <> 'owner' AND status = 'active';
        `,
        values: [input.workspaceId, target.user_id],
      });
      if (previousUpdate.rowCount !== 1 || targetUpdate.rowCount !== 1 || !events[0]) {
        throw new WorkspaceOwnershipTransferError(
          'TRANSFER_CONFLICT',
          'workspace ownership changed; refresh and try again',
        );
      }
      const updated = await session.query<MembershipRow>({
        text: `
          SELECT m.id, m.workspace_id, m.user_id, u.email, m.role, m.status,
            m.created_at, m.updated_at
          FROM workspace_memberships m JOIN users u ON u.id = m.user_id
          WHERE m.workspace_id = $1 AND m.user_id IN ($2, $3);
        `,
        values: [input.workspaceId, currentOwner.user_id, target.user_id],
      });
      const previousOwner = updated.find((row) => Number(row.user_id) === currentOwner.user_id);
      const newOwner = updated.find((row) => Number(row.user_id) === target.user_id);
      if (!previousOwner || !newOwner || previousOwner.role !== 'admin' || newOwner.role !== 'owner') {
        throw new WorkspaceOwnershipTransferError(
          'TRANSFER_CONFLICT',
          'workspace ownership transfer could not be verified',
        );
      }
      return {
        eventId,
        workspaceId: input.workspaceId,
        previousOwner: toMembership(previousOwner),
        newOwner: toMembership(newOwner),
        transferredAt: databaseTimestamp(events[0].created_at),
      };
    });
  }
}

function validateMemberships(
  currentOwner: MembershipRow | undefined,
  target: MembershipRow | undefined,
  confirmedTargetEmail: string,
): void {
  if (currentOwner?.role !== 'owner' || currentOwner.status !== 'active') {
    throw new WorkspaceOwnershipTransferError(
      'CURRENT_OWNER_REQUIRED',
      'only the active workspace owner can transfer ownership',
    );
  }
  if (target?.user_id === currentOwner.user_id) {
    throw new WorkspaceOwnershipTransferError(
      'TARGET_MEMBER_INVALID',
      'ownership must be transferred to another active member',
    );
  }
  if (!target || target.status !== 'active') {
    throw new WorkspaceOwnershipTransferError(
      'TARGET_MEMBER_NOT_FOUND',
      'target workspace member was not found',
    );
  }
  if (target.role === 'owner') {
    throw new WorkspaceOwnershipTransferError(
      'TARGET_MEMBER_INVALID',
      'target member already owns the workspace',
    );
  }
  if (confirmedTargetEmail !== target.email) {
    throw new WorkspaceOwnershipTransferError(
      'TARGET_CONFIRMATION_MISMATCH',
      'target member email confirmation does not match',
    );
  }
}

function toMembership(row: MembershipRow): WorkspaceMembershipRecord {
  return {
    id: Number(row.id),
    workspaceId: Number(row.workspace_id),
    userId: Number(row.user_id),
    email: row.email,
    role: row.role,
    status: row.status,
    createdAt: databaseTimestamp(row.created_at),
    updatedAt: databaseTimestamp(row.updated_at),
  };
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new WorkspaceOwnershipTransferError(
      'TARGET_MEMBER_INVALID',
      `${field} must be a positive integer`,
    );
  }
  return parsed;
}
