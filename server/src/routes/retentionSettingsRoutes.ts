import Router from '@koa/router';
import type Koa from 'koa';

import { BillingError, BillingRepository } from '../services/billingRepository';
import { sendApiError } from '../services/apiErrors';
import { type StructuredLogger } from '../services/logger';
import { verifyPassword } from '../services/passwordHash';
import { RetentionPolicyRepository } from '../services/retentionPolicyRepository';
import { RetentionService } from '../services/retentionService';
import { UserRepository } from '../services/userRepository';
import {
  hasWorkspacePermission,
  type WorkspacePermission,
} from '../services/workspaceAuthorization';

interface RetentionSettingsRouteDependencies {
  authorize: (ctx: Koa.Context, permission: WorkspacePermission) => boolean;
  billing: BillingRepository;
  currentUserId: (ctx: Koa.Context) => number;
  currentWorkspaceId: (ctx: Koa.Context) => number;
  logger: StructuredLogger;
  policies: RetentionPolicyRepository;
  retention: RetentionService;
  schedule: (workspaceId: number) => void;
  users: UserRepository;
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

  router.get('/api/settings/retention', (ctx) => {
    if (!authorize(ctx, 'workspace.read')) return;
    ctx.body = retentionState(ctx, dependencies);
  });

  router.put('/api/settings/retention', (ctx) => {
    if (!authorize(ctx, 'retention.manage')) return;
    const workspaceId = currentWorkspaceId(ctx);
    if (!assertRetentionEntitled(ctx, logger, billing, workspaceId)) return;
    const body = ctx.request.body as Record<string, unknown>;
    if (!reauthenticate(ctx, logger, users, currentUserId(ctx), body.password)) return;
    try {
      policies.update({
        workspaceId,
        conversationDays: body.conversationDays,
        runDays: body.runDays,
        documentDays: body.documentDays,
        actorUserId: currentUserId(ctx),
      });
      schedule(workspaceId);
      ctx.body = retentionState(ctx, dependencies);
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
    if (!assertRetentionEntitled(ctx, logger, billing, workspaceId)) return;
    const body = ctx.request.body as Record<string, unknown>;
    if (!reauthenticate(ctx, logger, users, currentUserId(ctx), body.password)) return;
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

function retentionState(
  ctx: Koa.Context,
  dependencies: RetentionSettingsRouteDependencies,
): Record<string, unknown> {
  const workspaceId = dependencies.currentWorkspaceId(ctx);
  const entitlement = dependencies.billing
    .entitlementSnapshot(workspaceId)
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

function assertRetentionEntitled(
  ctx: Koa.Context,
  logger: StructuredLogger,
  billing: BillingRepository,
  workspaceId: number,
): boolean {
  try {
    billing.assertEntitled(workspaceId, 'retention.controls');
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

function reauthenticate(
  ctx: Koa.Context,
  logger: StructuredLogger,
  users: UserRepository,
  userId: number,
  passwordValue: unknown,
): boolean {
  const user = users.findById(userId);
  const password = typeof passwordValue === 'string' ? passwordValue : '';
  if (user && verifyPassword(password, user.passwordHash)) return true;
  sendApiError(ctx, logger, {
    status: 401,
    code: 'REAUTHENTICATION_REQUIRED',
    message: 'current password is required for retention changes',
  });
  return false;
}
