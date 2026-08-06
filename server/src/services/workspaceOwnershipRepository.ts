import { randomUUID } from 'node:crypto';

import { SqliteDatabase, sqlValue } from '../db/sqlite';
import { normalizeEmail } from './userRepository';
import {
  type WorkspaceMembershipRecord,
  WorkspaceRepository,
} from './workspaceRepository';

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

interface OwnershipEventRow {
  event_id: string;
  workspace_id: number;
  previous_owner_user_id: number;
  new_owner_user_id: number;
  created_at: string;
}

export class WorkspaceOwnershipRepository {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly workspaces = new WorkspaceRepository(db),
  ) {}

  transfer(input: {
    workspaceId: number;
    currentOwnerUserId: number;
    targetUserId: unknown;
    confirmedTargetEmail: unknown;
  }): WorkspaceOwnershipTransferRecord {
    const targetUserId = positiveInteger(input.targetUserId, 'targetUserId');
    const currentOwner = this.workspaces.findMembership(
      input.workspaceId,
      input.currentOwnerUserId,
    );
    if (currentOwner?.role !== 'owner' || currentOwner.status !== 'active') {
      throw new WorkspaceOwnershipTransferError(
        'CURRENT_OWNER_REQUIRED',
        'only the active workspace owner can transfer ownership',
      );
    }
    if (targetUserId === currentOwner.userId) {
      throw new WorkspaceOwnershipTransferError(
        'TARGET_MEMBER_INVALID',
        'ownership must be transferred to another active member',
      );
    }

    const target = this.workspaces.findMembership(input.workspaceId, targetUserId);
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
    if (normalizeEmail(input.confirmedTargetEmail) !== target.email) {
      throw new WorkspaceOwnershipTransferError(
        'TARGET_CONFIRMATION_MISMATCH',
        'target member email confirmation does not match',
      );
    }

    const eventId = randomUUID();
    this.db.run(`
      BEGIN IMMEDIATE;

      INSERT INTO workspace_ownership_events (
        event_id,
        workspace_id,
        previous_owner_user_id,
        new_owner_user_id,
        initiated_by_user_id
      )
      SELECT
        ${sqlValue(eventId)},
        ${sqlValue(input.workspaceId)},
        ${sqlValue(currentOwner.userId)},
        ${sqlValue(target.userId)},
        ${sqlValue(currentOwner.userId)}
      WHERE EXISTS (
        SELECT 1 FROM workspace_memberships
        WHERE workspace_id = ${sqlValue(input.workspaceId)}
          AND user_id = ${sqlValue(currentOwner.userId)}
          AND role = 'owner'
          AND status = 'active'
      ) AND EXISTS (
        SELECT 1 FROM workspace_memberships
        WHERE workspace_id = ${sqlValue(input.workspaceId)}
          AND user_id = ${sqlValue(target.userId)}
          AND role <> 'owner'
          AND status = 'active'
      );

      UPDATE workspace_memberships
      SET role = 'admin', updated_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ${sqlValue(input.workspaceId)}
        AND user_id = ${sqlValue(currentOwner.userId)}
        AND EXISTS (
          SELECT 1 FROM workspace_ownership_events
          WHERE event_id = ${sqlValue(eventId)}
        );

      UPDATE workspace_memberships
      SET role = 'owner', updated_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ${sqlValue(input.workspaceId)}
        AND user_id = ${sqlValue(target.userId)}
        AND EXISTS (
          SELECT 1 FROM workspace_ownership_events
          WHERE event_id = ${sqlValue(eventId)}
        );

      COMMIT;
    `);

    const event = this.findEvent(eventId);
    if (!event) {
      throw new WorkspaceOwnershipTransferError(
        'TRANSFER_CONFLICT',
        'workspace ownership changed; refresh and try again',
      );
    }
    const previousOwner = this.workspaces.findMembership(input.workspaceId, currentOwner.userId);
    const newOwner = this.workspaces.findMembership(input.workspaceId, target.userId);
    if (!previousOwner || !newOwner || previousOwner.role !== 'admin' || newOwner.role !== 'owner') {
      throw new WorkspaceOwnershipTransferError(
        'TRANSFER_CONFLICT',
        'workspace ownership transfer could not be verified',
      );
    }
    return {
      eventId: event.event_id,
      workspaceId: Number(event.workspace_id),
      previousOwner,
      newOwner,
      transferredAt: event.created_at,
    };
  }

  private findEvent(eventId: string): OwnershipEventRow | null {
    return this.db.query<OwnershipEventRow>(`
      SELECT event_id, workspace_id, previous_owner_user_id, new_owner_user_id, created_at
      FROM workspace_ownership_events
      WHERE event_id = ${sqlValue(eventId)}
      LIMIT 1;
    `)[0] ?? null;
  }
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
