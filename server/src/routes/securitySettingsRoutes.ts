import Router from '@koa/router';
import type Koa from 'koa';

import { ApiKeyRepository } from '../services/apiKeyRepository';
import { sendApiError } from '../services/apiErrors';
import { type StructuredLogger } from '../services/logger';
import { verifyPassword } from '../services/passwordHash';
import { SessionRepository } from '../services/sessionRepository';
import { UserRepository } from '../services/userRepository';
import { type WorkspacePermission } from '../services/workspaceAuthorization';

interface SecuritySettingsRouteDependencies {
  apiKeys: ApiKeyRepository;
  authorize: (ctx: Koa.Context, permission: WorkspacePermission) => boolean;
  currentUserId: (ctx: Koa.Context) => number;
  currentWorkspaceId: (ctx: Koa.Context) => number;
  logger: StructuredLogger;
  sessions: SessionRepository;
  users: UserRepository;
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

  router.get('/api/settings/api-keys', (ctx) => {
    if (!authorize(ctx, 'api_keys.manage')) return;
    ctx.body = apiKeys.list(currentWorkspaceId(ctx));
  });

  router.post('/api/settings/api-keys', (ctx) => {
    if (!authorize(ctx, 'api_keys.manage')) return;
    const body = ctx.request.body as Record<string, unknown>;
    const user = users.findById(currentUserId(ctx));
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
      ctx.body = apiKeys.create({
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

  router.delete('/api/settings/api-keys/:id', (ctx) => {
    if (!authorize(ctx, 'api_keys.manage')) return;
    try {
      apiKeys.revoke(currentWorkspaceId(ctx), Number(ctx.params.id));
      ctx.status = 204;
    } catch (error) {
      sendApiError(ctx, logger, {
        status: 404,
        code: 'API_KEY_NOT_FOUND',
        message: error instanceof Error ? error.message : 'API key not found',
      });
    }
  });

  router.get('/api/settings/sessions', (ctx) => {
    const token = ctx.state.sessionToken;
    if (!token) return sessionTokenRequired(ctx, logger);
    ctx.body = sessions.listForUser(currentUserId(ctx), token);
  });

  router.delete('/api/settings/sessions/:id', (ctx) => {
    const token = ctx.state.sessionToken;
    if (!token) return sessionTokenRequired(ctx, logger);
    try {
      sessions.revokeForUser(currentUserId(ctx), Number(ctx.params.id), token);
      ctx.status = 204;
    } catch (error) {
      sendApiError(ctx, logger, {
        status: 400,
        code: 'SESSION_INVALID',
        message: error instanceof Error ? error.message : 'failed to revoke session',
      });
    }
  });

  router.post('/api/settings/sessions/revoke-others', (ctx) => {
    const token = ctx.state.sessionToken;
    if (!token) return sessionTokenRequired(ctx, logger);
    ctx.body = { revoked: sessions.revokeOthers(currentUserId(ctx), token) };
  });
}

function sessionTokenRequired(ctx: Koa.Context, logger: StructuredLogger): void {
  sendApiError(ctx, logger, {
    status: 401,
    code: 'AUTHENTICATION_REQUIRED',
    message: 'browser session authentication is required',
  });
}
