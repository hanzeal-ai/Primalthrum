import Router from '@koa/router';
import type Koa from 'koa';

import { sendApiError } from '../services/apiErrors';
import { type StructuredLogger } from '../services/logger';
import { verifyPassword } from '../services/passwordHash';
import { type UserStore } from '../services/userStore';
import {
  WorkspaceOwnershipRepository,
  WorkspaceOwnershipTransferError,
} from '../services/workspaceOwnershipRepository';
import { type WorkspacePermission } from '../services/workspaceAuthorization';

interface WorkspaceOwnershipRouteDependencies {
  authorize: (ctx: Koa.Context, permission: WorkspacePermission) => boolean;
  currentUserId: (ctx: Koa.Context) => number;
  logger: StructuredLogger;
  ownership: WorkspaceOwnershipRepository;
  requireCurrentWorkspace: (ctx: Koa.Context, workspaceId: number) => boolean;
  users: UserStore;
}

export function registerWorkspaceOwnershipRoutes(
  router: Router,
  dependencies: WorkspaceOwnershipRouteDependencies,
): void {
  router.put('/api/workspaces/:id/ownership', async (ctx) => {
    const workspaceId = Number(ctx.params.id);
    if (!dependencies.requireCurrentWorkspace(ctx, workspaceId)) return;
    if (!dependencies.authorize(ctx, 'workspace.manage')) return;
    const body = ctx.request.body as Record<string, unknown>;
    const userId = dependencies.currentUserId(ctx);
    if (!await reauthenticate(ctx, dependencies, userId, body.password)) return;
    try {
      ctx.body = dependencies.ownership.transfer({
        workspaceId,
        currentOwnerUserId: userId,
        targetUserId: body.targetUserId,
        confirmedTargetEmail: body.confirmTargetEmail,
      });
    } catch (error) {
      sendOwnershipError(ctx, dependencies.logger, error);
    }
  });
}

async function reauthenticate(
  ctx: Koa.Context,
  dependencies: WorkspaceOwnershipRouteDependencies,
  userId: number,
  passwordValue: unknown,
): Promise<boolean> {
  const user = await dependencies.users.findById(userId);
  const password = typeof passwordValue === 'string' ? passwordValue : '';
  if (user && verifyPassword(password, user.passwordHash)) return true;
  sendApiError(ctx, dependencies.logger, {
    status: 401,
    code: 'REAUTHENTICATION_REQUIRED',
    message: 'current password is required to transfer workspace ownership',
  });
  return false;
}

function sendOwnershipError(
  ctx: Koa.Context,
  logger: StructuredLogger,
  error: unknown,
): void {
  if (error instanceof WorkspaceOwnershipTransferError) {
    const status = ({
      CURRENT_OWNER_REQUIRED: 403,
      TARGET_MEMBER_NOT_FOUND: 404,
      TARGET_MEMBER_INVALID: 400,
      TARGET_CONFIRMATION_MISMATCH: 400,
      TRANSFER_CONFLICT: 409,
    } as const)[error.code];
    sendApiError(ctx, logger, {
      status,
      code: `WORKSPACE_OWNERSHIP_${error.code}`,
      message: error.message,
    });
    return;
  }
  sendApiError(ctx, logger, {
    status: 400,
    code: 'WORKSPACE_OWNERSHIP_TRANSFER_FAILED',
    message: error instanceof Error ? error.message : 'workspace ownership transfer failed',
  });
}
