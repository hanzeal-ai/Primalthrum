import Router from '@koa/router';
import type Koa from 'koa';

import { type ApiKeyStore } from '../services/apiKeyStore';
import { sendApiError } from '../services/apiErrors';
import { type StructuredLogger } from '../services/logger';
import { verifyPassword } from '../services/passwordHash';
import { type SessionStore } from '../services/sessionStore';
import { type UserStore } from '../services/userStore';
import { type WorkspacePermission } from '../services/workspaceAuthorization';

interface SecuritySettingsRouteDependencies {
  apiKeys: ApiKeyStore;
  authorize: (ctx: Koa.Context, permission: WorkspacePermission) => boolean;
  currentUserId: (ctx: Koa.Context) => number;
  currentWorkspaceId: (ctx: Koa.Context) => number;
  logger: StructuredLogger;
  sessions: SessionStore;
  users: UserStore;
}

export function registerSecuritySettingsRoutes(
  router: Router,
  dependencies: SecuritySettingsRouteDependencies,
): void {
  const {
    apiKeys,
    authorize,
    currentUserId,
    currentWorkspaceId,
    logger,
    sessions,
    users,
  } = dependencies;

  router.get('/api/settings/api-keys', async (ctx) => {
    if (!authorize(ctx, 'api_keys.manage')) return;
    ctx.body = await apiKeys.list(currentWorkspaceId(ctx));
  });

  router.post('/api/settings/api-keys', async (ctx) => {
    if (!authorize(ctx, 'api_keys.manage')) return;
    const body = ctx.request.body as Record<string, unknown>;
    const user = await users.findById(currentUserId(ctx));
    const password = typeof body.password === 'string' ? body.password : '';
    if (!user || !verifyPassword(password, user.passwordHash)) {
      sendApiError(ctx, logger, {
        status: 401,
        code: 'REAUTHENTICATION_REQUIRED',
        message: 'current password is required to create an API key',
      });
      return;
    }
    try {
      ctx.status = 201;
      ctx.body = await apiKeys.create({
        workspaceId: currentWorkspaceId(ctx),
        name: body.name,
        scopes: body.scopes,
        expiresInDays: body.expiresInDays,
        createdByUserId: currentUserId(ctx),
      });
    } catch (error) {
      sendApiError(ctx, logger, {
        status: 400,
        code: 'API_KEY_INVALID',
        message: error instanceof Error ? error.message : 'failed to create API key',
      });
    }
  });

  router.delete('/api/settings/api-keys/:id', async (ctx) => {
    if (!authorize(ctx, 'api_keys.manage')) return;
    try {
      await apiKeys.revoke(currentWorkspaceId(ctx), Number(ctx.params.id));
      ctx.status = 204;
    } catch (error) {
      sendApiError(ctx, logger, {
        status: 404,
        code: 'API_KEY_NOT_FOUND',
        message: error instanceof Error ? error.message : 'API key not found',
      });
    }
  });

  router.get('/api/settings/sessions', async (ctx) => {
    const token = ctx.state.sessionToken;
    if (!token) return sessionTokenRequired(ctx, logger);
    ctx.body = await sessions.listForUser(currentUserId(ctx), token);
  });

  router.delete('/api/settings/sessions/:id', async (ctx) => {
    const token = ctx.state.sessionToken;
    if (!token) return sessionTokenRequired(ctx, logger);
    try {
      await sessions.revokeForUser(currentUserId(ctx), Number(ctx.params.id), token);
      ctx.status = 204;
    } catch (error) {
      sendApiError(ctx, logger, {
        status: 400,
        code: 'SESSION_INVALID',
        message: error instanceof Error ? error.message : 'failed to revoke session',
      });
    }
  });

  router.post('/api/settings/sessions/revoke-others', async (ctx) => {
    const token = ctx.state.sessionToken;
    if (!token) return sessionTokenRequired(ctx, logger);
    ctx.body = { revoked: await sessions.revokeOthers(currentUserId(ctx), token) };
  });
}

function sessionTokenRequired(ctx: Koa.Context, logger: StructuredLogger): void {
  sendApiError(ctx, logger, {
    status: 401,
    code: 'AUTHENTICATION_REQUIRED',
    message: 'browser session authentication is required',
  });
}
