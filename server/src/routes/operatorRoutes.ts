import Router from '@koa/router';
import { timingSafeEqual } from 'node:crypto';
import type Koa from 'koa';

import { type StructuredLogger } from '../services/logger';
import { type OperatorAuditStore } from '../services/operatorAuditStore';
import {
  hasOperatorPermission,
  type OperatorPermission,
} from '../services/operatorAuthorization';
import { type AuthenticatedOperatorSession } from '../services/operatorIdentityRepository';
import { type OperatorIdentityStore } from '../services/operatorIdentityStore';
import { OperatorReadRepository } from '../services/operatorReadRepository';
import { hashPassword, verifyPassword, verifyPasswordOrDummy } from '../services/passwordHash';
import { SupportAccessRepository } from '../services/supportAccessRepository';

export interface OperatorRouteSecurityOptions {
  audit: OperatorAuditStore;
  identity: OperatorIdentityStore;
  logger: StructuredLogger;
}

interface OperatorRouteOptions extends OperatorRouteSecurityOptions {
  bootstrapToken?: string;
  enforceAbuse: (ctx: Koa.Context) => Promise<boolean>;
  reads: OperatorReadRepository;
  readiness: () => Promise<unknown>;
  support: SupportAccessRepository;
}

export function registerOperatorRoutes(
  router: Router,
  options: OperatorRouteOptions,
): void {
  router.get('/api/operator/setup/status', async (ctx) => {
    ctx.body = {
      needsSetup: await options.identity.needsSetup(),
      setupEnabled: validConfiguredBootstrapToken(options.bootstrapToken),
    };
  });

  router.post('/api/operator/setup', async (ctx) => {
    if (!await options.enforceAbuse(ctx)) return;
    if (!await options.identity.needsSetup()) {
      operatorError(ctx, options.logger, 409, 'OPERATOR_SETUP_COMPLETE', 'operator setup is already complete');
      return;
    }
    if (!validBootstrapToken(options.bootstrapToken, ctx.get('x-operator-bootstrap-token'))) {
      operatorError(ctx, options.logger, 403, 'OPERATOR_BOOTSTRAP_FORBIDDEN', 'operator bootstrap token is invalid');
      return;
    }
    try {
      const body = requestBody(ctx);
      const password = normalizeOperatorPassword(body.password);
      const user = await options.identity.createInitial(body.email, hashPassword(password));
      const session = await options.identity.createSession(user.id);
      await options.audit.record({
        operatorUserId: user.id,
        eventType: 'operator.setup_completed',
        targetType: 'operator',
        targetId: user.id,
      });
      ctx.status = 201;
      ctx.body = { user, session };
    } catch (error) {
      operatorRequestError(ctx, options.logger, error);
    }
  });

  router.post('/api/operator/auth/login', async (ctx) => {
    if (!await options.enforceAbuse(ctx)) return;
    const body = requestBody(ctx);
    const password = typeof body.password === 'string' ? body.password : '';
    const credentials = await options.identity.findCredentialsByEmail(body.email);
    if (
      !verifyPasswordOrDummy(password, credentials?.passwordHash ?? null)
      || credentials?.status !== 'active'
    ) {
      await options.audit.record({
        eventType: 'operator.login_failed',
        targetType: 'operator',
        metadata: { identityProvided: typeof body.email === 'string' && Boolean(body.email.trim()) },
      });
      operatorError(ctx, options.logger, 401, 'OPERATOR_AUTHENTICATION_FAILED', 'invalid operator credentials');
      return;
    }
    const session = await options.identity.createSession(credentials.id);
    await options.audit.record({
      operatorUserId: credentials.id,
      eventType: 'operator.login_succeeded',
      targetType: 'operator',
      targetId: credentials.id,
    });
    const { passwordHash: _, ...user } = credentials;
    ctx.body = { user, session };
  });

  router.get('/api/operator/auth/session', async (ctx) => {
    const authenticated = await requireOperator(ctx, options);
    if (!authenticated) return;
    ctx.body = { user: authenticated.user, expiresAt: authenticated.expiresAt };
  });

  router.post('/api/operator/auth/logout', async (ctx) => {
    const authenticated = await requireOperator(ctx, options);
    if (!authenticated) return;
    await options.identity.revokeToken(operatorToken(ctx));
    await options.audit.record({
      operatorUserId: authenticated.user.id,
      eventType: 'operator.logout',
      targetType: 'operator',
      targetId: authenticated.user.id,
    });
    ctx.status = 204;
  });

  router.put('/api/operator/auth/password', async (ctx) => {
    const authenticated = await requireOperator(ctx, options, undefined, true);
    if (!authenticated) return;
    const body = requestBody(ctx);
    const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    const credentials = await options.identity.findCredentialsByEmail(authenticated.user.email);
    if (!credentials || !verifyPassword(currentPassword, credentials.passwordHash)) {
      operatorError(ctx, options.logger, 403, 'OPERATOR_REAUTHENTICATION_REQUIRED', 'current password is invalid');
      return;
    }
    try {
      const password = normalizeOperatorPassword(body.password);
      await options.identity.updatePassword(authenticated.user.id, hashPassword(password));
      const session = await options.identity.createSession(authenticated.user.id);
      const user = await options.identity.findById(authenticated.user.id);
      await options.audit.record({
        operatorUserId: authenticated.user.id,
        eventType: 'operator.password_changed',
        targetType: 'operator',
        targetId: authenticated.user.id,
      });
      ctx.body = { user, session };
    } catch (error) {
      operatorRequestError(ctx, options.logger, error);
    }
  });

  router.get('/api/operator/overview', async (ctx) => {
    const authenticated = await requireOperator(ctx, options, 'overview.read');
    if (!authenticated) return;
    const [readiness, overview] = await Promise.all([
      options.readiness(),
      Promise.resolve(options.reads.overview()),
    ]);
    await options.audit.record({
      operatorUserId: authenticated.user.id,
      eventType: 'operator.overview_read',
      targetType: 'platform',
    });
    ctx.body = { overview, readiness };
  });

  router.get('/api/operator/workspaces', async (ctx) => {
    const authenticated = await requireOperator(ctx, options, 'workspaces.read');
    if (!authenticated) return;
    const workspaces = await options.reads.listWorkspaces(queryLimit(ctx.query.limit));
    await options.audit.record({
      operatorUserId: authenticated.user.id,
      eventType: 'operator.workspaces_read',
      targetType: 'workspace',
      metadata: { count: workspaces.length },
    });
    ctx.body = workspaces;
  });

  router.get('/api/operator/workspaces/:id', async (ctx) => {
    const authenticated = await requireOperator(ctx, options, 'workspaces.read');
    if (!authenticated) return;
    const workspace = await options.reads.workspace(positiveId(ctx.params.id));
    if (!workspace) {
      operatorError(ctx, options.logger, 404, 'OPERATOR_WORKSPACE_NOT_FOUND', 'workspace not found');
      return;
    }
    await options.audit.record({
      operatorUserId: authenticated.user.id,
      eventType: 'operator.workspace_read',
      targetType: 'workspace',
      targetId: workspace.id,
    });
    ctx.body = workspace;
  });

  router.get('/api/operator/operators', async (ctx) => {
    const authenticated = await requireOperator(ctx, options, 'operators.read');
    if (!authenticated) return;
    ctx.body = await options.identity.list();
  });

  router.post('/api/operator/operators', async (ctx) => {
    const authenticated = await requireOperator(ctx, options, 'operators.manage');
    if (!authenticated) return;
    try {
      const body = requestBody(ctx);
      const user = await options.identity.create({
        email: body.email,
        passwordHash: hashPassword(normalizeOperatorPassword(body.password)),
        role: body.role,
      });
      await options.audit.record({
        operatorUserId: authenticated.user.id,
        eventType: 'operator.user_created',
        targetType: 'operator',
        targetId: user.id,
        metadata: { role: user.role },
      });
      ctx.status = 201;
      ctx.body = user;
    } catch (error) {
      operatorRequestError(ctx, options.logger, error);
    }
  });

  router.get('/api/operator/support-grants', async (ctx) => {
    const authenticated = await requireOperator(ctx, options, 'support.read');
    if (!authenticated) return;
    const canManage = hasOperatorPermission(authenticated.user.role, 'support.manage');
    ctx.body = await options.support.list(canManage ? undefined : authenticated.user.id);
  });

  router.post('/api/operator/support-grants', async (ctx) => {
    const authenticated = await requireOperator(ctx, options, 'support.manage');
    if (!authenticated) return;
    try {
      const body = requestBody(ctx);
      const grant = await options.support.create({
        workspaceId: positiveId(body.workspaceId),
        operatorUserId: positiveId(body.operatorUserId),
        permissions: body.permissions,
        reason: body.reason,
        ticketRef: body.ticketRef,
        expiresAt: body.expiresAt,
        createdByOperatorId: authenticated.user.id,
      });
      await options.audit.record({
        operatorUserId: authenticated.user.id,
        eventType: 'operator.support_grant_created',
        targetType: 'support_grant',
        targetId: grant.id,
        metadata: {
          workspaceId: grant.workspaceId,
          assignedOperatorId: grant.operatorUserId,
          permissions: grant.permissions,
          ticketRef: grant.ticketRef,
          expiresAt: grant.expiresAt,
        },
      });
      ctx.status = 201;
      ctx.body = grant;
    } catch (error) {
      operatorRequestError(ctx, options.logger, error);
    }
  });

  router.delete('/api/operator/support-grants/:id', async (ctx) => {
    const authenticated = await requireOperator(ctx, options, 'support.manage');
    if (!authenticated) return;
    const grant = await options.support.revoke(positiveId(ctx.params.id), authenticated.user.id);
    if (!grant) {
      operatorError(ctx, options.logger, 404, 'OPERATOR_SUPPORT_GRANT_NOT_FOUND', 'support grant not found');
      return;
    }
    await options.audit.record({
      operatorUserId: authenticated.user.id,
      eventType: 'operator.support_grant_revoked',
      targetType: 'support_grant',
      targetId: grant.id,
      metadata: { workspaceId: grant.workspaceId, assignedOperatorId: grant.operatorUserId },
    });
    ctx.body = grant;
  });

  router.get('/api/operator/support-grants/:id/context', async (ctx) => {
    const authenticated = await requireOperator(ctx, options, 'support.use');
    if (!authenticated) return;
    const grant = await options.support.findActive(positiveId(ctx.params.id), authenticated.user.id);
    if (!grant) {
      operatorError(ctx, options.logger, 403, 'OPERATOR_SUPPORT_ACCESS_DENIED', 'active assigned support access is required');
      return;
    }
    const context = await options.reads.supportContext(grant.workspaceId, grant.permissions);
    if (!context) {
      operatorError(ctx, options.logger, 404, 'OPERATOR_WORKSPACE_NOT_FOUND', 'workspace not found');
      return;
    }
    await options.audit.record({
      operatorUserId: authenticated.user.id,
      eventType: 'operator.support_context_read',
      targetType: 'workspace',
      targetId: grant.workspaceId,
      metadata: { grantId: grant.id, ticketRef: grant.ticketRef, permissions: grant.permissions },
    });
    ctx.body = { grant, context };
  });

  router.get('/api/operator/audit', async (ctx) => {
    const authenticated = await requireOperator(ctx, options, 'audit.read');
    if (!authenticated) return;
    const events = await options.audit.list(queryLimit(ctx.query.limit));
    await options.audit.record({
      operatorUserId: authenticated.user.id,
      eventType: 'operator.audit_read',
      targetType: 'operator_audit',
      metadata: { count: events.length },
    });
    ctx.body = events;
  });
}

export function requireOperator(
  ctx: Koa.Context,
  options: OperatorRouteSecurityOptions,
  permission?: OperatorPermission,
  allowPasswordChange = false,
): Promise<AuthenticatedOperatorSession | null> {
  return requireOperatorAsync(ctx, options, permission, allowPasswordChange);
}

async function requireOperatorAsync(
  ctx: Koa.Context,
  options: OperatorRouteSecurityOptions,
  permission?: OperatorPermission,
  allowPasswordChange = false,
): Promise<AuthenticatedOperatorSession | null> {
  const session = await options.identity.findByToken(operatorToken(ctx));
  if (!session) {
    operatorError(ctx, options.logger, 401, 'OPERATOR_AUTHENTICATION_REQUIRED', 'operator authentication is required');
    return null;
  }
  if (session.user.mustChangePassword && !allowPasswordChange) {
    operatorError(ctx, options.logger, 403, 'OPERATOR_PASSWORD_CHANGE_REQUIRED', 'operator password change is required');
    return null;
  }
  if (permission && !hasOperatorPermission(session.user.role, permission)) {
    await options.audit.record({
      operatorUserId: session.user.id,
      eventType: 'operator.authorization_denied',
      targetType: 'permission',
      targetId: permission,
    });
    operatorError(ctx, options.logger, 403, 'OPERATOR_AUTHORIZATION_FORBIDDEN', `permission ${permission} is required`);
    return null;
  }
  return session;
}

function operatorToken(ctx: Koa.Context): string {
  const match = /^Bearer\s+(.+)$/i.exec(ctx.get('authorization'));
  return match?.[1]?.trim() ?? '';
}

function requestBody(ctx: Koa.Context): Record<string, unknown> {
  return ctx.request.body && typeof ctx.request.body === 'object'
    ? ctx.request.body as Record<string, unknown>
    : {};
}

function normalizeOperatorPassword(value: unknown): string {
  if (typeof value !== 'string' || value.length < 16 || value.length > 256) {
    throw new Error('operator password must contain 16-256 characters');
  }
  return value;
}

function positiveId(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error('identifier is invalid');
  return parsed;
}

function queryLimit(value: unknown): number {
  const candidate = Array.isArray(value) ? value[0] : value;
  const parsed = Number(candidate ?? 100);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 200) : 100;
}

function validConfiguredBootstrapToken(token: string | undefined): boolean {
  return Boolean(token && Buffer.byteLength(token) >= 32);
}

function validBootstrapToken(expected: string | undefined, provided: string): boolean {
  if (!validConfiguredBootstrapToken(expected)) return false;
  const expectedBuffer = Buffer.from(expected ?? '');
  const providedBuffer = Buffer.from(provided);
  return expectedBuffer.length === providedBuffer.length
    && timingSafeEqual(expectedBuffer, providedBuffer);
}

function operatorRequestError(
  ctx: Koa.Context,
  logger: StructuredLogger,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : 'operator request is invalid';
  const status = /already|unique/i.test(message) ? 409 : 400;
  operatorError(
    ctx,
    logger,
    status,
    'OPERATOR_REQUEST_INVALID',
    status === 409 ? 'operator record already exists' : message,
  );
}

export function operatorError(
  ctx: Koa.Context,
  logger: StructuredLogger,
  status: number,
  code: string,
  message: string,
): void {
  ctx.status = status;
  ctx.body = { error: { code, message, status } };
  logger.log({
    level: status >= 500 ? 'error' : 'warn',
    code,
    message,
    context: { method: ctx.method, path: ctx.path, status },
  });
}
