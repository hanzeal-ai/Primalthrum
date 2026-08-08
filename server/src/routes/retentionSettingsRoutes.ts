import Router from '@koa/router';
import type Koa from 'koa';

import { BillingError } from '../services/billingRepository';
import { type BillingStore } from '../services/billingStore';
import { sendApiError } from '../services/apiErrors';
import { type StructuredLogger } from '../services/logger';
import { verifyPassword } from '../services/passwordHash';
import { RetentionPolicyRepository } from '../services/retentionPolicyRepository';
import { RetentionService } from '../services/retentionService';
import { type UserStore } from '../services/userStore';
import {
  hasWorkspacePermission,
  type WorkspacePermission,
} from '../services/workspaceAuthorization';

interface RetentionSettingsRouteDependencies {
  authorize: (ctx: Koa.Context, permission: WorkspacePermission) => boolean;
  billing: BillingStore;
  currentUserId: (ctx: Koa.Context) => number;
  currentWorkspaceId: (ctx: Koa.Context) => number;
  logger: StructuredLogger;
  policies: RetentionPolicyRepository;
  retention: RetentionService;
  schedule: (workspaceId: number) => void;
  users: UserStore;
}

export function registerRetentionSettingsRoutes(
  router: Router,
  dependencies: RetentionSettingsRouteDependencies,
): void {
  const {
    authorize,
    billing,
    currentUserId,
    currentWorkspaceId,
    logger,
    policies,
    retention,
    schedule,
    users,
  } = dependencies;

  router.get('/api/settings/retention', async (ctx) => {
    if (!authorize(ctx, 'workspace.read')) return;
    ctx.body = await retentionState(ctx, dependencies);
  });

  router.put('/api/settings/retention', async (ctx) => {
    if (!authorize(ctx, 'retention.manage')) return;
    const workspaceId = currentWorkspaceId(ctx);
    if (!await assertRetentionEntitled(ctx, logger, billing, workspaceId)) return;
    const body = ctx.request.body as Record<string, unknown>;
    if (!await reauthenticate(ctx, logger, users, currentUserId(ctx), body.password)) return;
    try {
      policies.update({
        workspaceId,
        conversationDays: body.conversationDays,
        runDays: body.runDays,
        documentDays: body.documentDays,
        actorUserId: currentUserId(ctx),
      });
      schedule(workspaceId);
      ctx.body = await retentionState(ctx, dependencies);
    } catch (error) {
      sendApiError(ctx, logger, {
        status: 400,
        code: 'RETENTION_POLICY_INVALID',
        message: error instanceof Error ? error.message : 'retention policy is invalid',
      });
    }
  });

  router.post('/api/settings/retention/enforce', async (ctx) => {
    if (!authorize(ctx, 'retention.manage')) return;
    const workspaceId = currentWorkspaceId(ctx);
    if (!await assertRetentionEntitled(ctx, logger, billing, workspaceId)) return;
    const body = ctx.request.body as Record<string, unknown>;
    if (!await reauthenticate(ctx, logger, users, currentUserId(ctx), body.password)) return;
    try {
      ctx.body = await retention.enforce(workspaceId, currentUserId(ctx));
    } catch (error) {
      sendApiError(ctx, logger, {
        status: 500,
        code: 'RETENTION_ENFORCEMENT_FAILED',
        message: error instanceof Error ? error.message : 'retention enforcement failed',
      });
    }
  });
}

async function retentionState(
  ctx: Koa.Context,
  dependencies: RetentionSettingsRouteDependencies,
): Promise<Record<string, unknown>> {
  const workspaceId = dependencies.currentWorkspaceId(ctx);
  const entitlement = (await dependencies.billing.entitlementSnapshot(workspaceId))
    .entitlements['retention.controls'];
  const role = String(ctx.state.authSession?.user.role ?? '');
  return {
    policy: dependencies.policies.get(workspaceId),
    preview: dependencies.policies.preview(workspaceId),
    events: dependencies.policies.listEvents(workspaceId),
    customRetentionEnabled: Boolean(entitlement?.enabled),
    canManage: hasWorkspacePermission(role, 'retention.manage'),
    legalHoldActive: dependencies.policies.hasActiveLegalHold(workspaceId),
  };
}

async function assertRetentionEntitled(
  ctx: Koa.Context,
  logger: StructuredLogger,
  billing: BillingStore,
  workspaceId: number,
): Promise<boolean> {
  try {
    await billing.assertEntitled(workspaceId, 'retention.controls');
    return true;
  } catch (error) {
    const code = error instanceof BillingError
      && (error.code === 'ENTITLEMENT_REQUIRED' || error.code === 'ENTITLEMENT_LIMIT_EXCEEDED')
      ? error.code
      : 'ENTITLEMENT_REQUIRED';
    sendApiError(ctx, logger, {
      status: 403,
      code,
      message: error instanceof Error ? error.message : 'retention controls are not enabled',
    });
    return false;
  }
}

async function reauthenticate(
  ctx: Koa.Context,
  logger: StructuredLogger,
  users: UserStore,
  userId: number,
  passwordValue: unknown,
): Promise<boolean> {
  const user = await users.findById(userId);
  const password = typeof passwordValue === 'string' ? passwordValue : '';
  if (user && verifyPassword(password, user.passwordHash)) return true;
  sendApiError(ctx, logger, {
    status: 401,
    code: 'REAUTHENTICATION_REQUIRED',
    message: 'current password is required for retention changes',
  });
  return false;
}
