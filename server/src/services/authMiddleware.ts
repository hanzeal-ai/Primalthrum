import Koa from 'koa';

import { type ApiKeyScope } from './apiKeyRepository';
import { type ApiKeyStore } from './apiKeyStore';
import {
  type AuthenticatedSession,
} from './sessionRepository';
import { type SessionStore } from './sessionStore';

export const SESSION_COOKIE_NAME = 'primalthrum_session';

export interface AuthContextState {
  apiKey?: { id: number; keyPrefix: string; scopes: ApiKeyScope[] };
  authSession?: AuthenticatedSession;
  sessionToken?: string;
}

export function createAuthMiddleware(
  sessions: SessionStore,
  apiKeys?: ApiKeyStore,
): Koa.Middleware<Koa.DefaultState & AuthContextState> {
  return async (ctx, next) => {
    if (isPublicRequest(ctx)) {
      await next();
      return;
    }

    const token = extractSessionToken(ctx);
    if (!token) {
      ctx.status = 401;
      ctx.body = { error: 'authentication required' };
      return;
    }

    const session = await sessions.findByToken(token);
    if (!session && apiKeys) {
      const apiKey = await apiKeys.resolve(token);
      if (apiKey) {
        if (!isApiKeyRequest(ctx)) {
          ctx.status = 403;
          ctx.body = {
            error: {
              code: 'API_KEY_SCOPE_FORBIDDEN',
              message: 'API keys can only access Agent runtime APIs',
              status: 403,
            },
          };
          return;
        }
        ctx.state.apiKey = {
          id: apiKey.id,
          keyPrefix: apiKey.keyPrefix,
          scopes: apiKey.scopes,
        };
        ctx.state.authSession = {
          user: apiKey.user,
          expiresAt: apiKey.expiresAt,
          emailVerified: apiKey.emailVerified,
        };
        await apiKeys.recordUse(apiKey.id, apiKey.user.workspaceId, ctx.method, ctx.path);
        await next();
        return;
      }
    }
    if (!session) {
      ctx.status = 401;
      ctx.body = { error: 'authentication required' };
      return;
    }

    ctx.state.authSession = session;
    ctx.state.sessionToken = token;
    if (!session.emailVerified && !isPendingEmailRequest(ctx)) {
      ctx.status = 403;
      ctx.body = {
        error: {
          code: 'EMAIL_VERIFICATION_REQUIRED',
          message: 'email verification is required',
          status: 403,
        },
      };
      return;
    }
    await next();
  };
}

function isApiKeyRequest(ctx: Koa.Context): boolean {
  return /^\/api\/(agents(?:\/|$)|conversations(?:\/|$)|runs(?:\/|$)|jobs(?:\/|$)|stream(?:\/|$))/.test(ctx.path);
}

export function extractSessionToken(ctx: Koa.Context): string | null {
  const authorization = ctx.get('authorization');
  const bearerMatch = /^Bearer\s+(.+)$/i.exec(authorization);
  if (bearerMatch?.[1]) {
    return bearerMatch[1].trim();
  }

  return parseCookie(ctx.get('cookie'))[SESSION_COOKIE_NAME] ?? null;
}

export function sessionCookie(token: string, expiresAt: string): string {
  const maxAge = Math.max(
    0,
    Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000),
  );
  return [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ].join('; ');
}

export function clearSessionCookie(): string {
  return [
    `${SESSION_COOKIE_NAME}=`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    'Max-Age=0',
  ].join('; ');
}

function isPublicRequest(ctx: Koa.Context): boolean {
  if (
    ctx.method === 'OPTIONS'
    || ctx.path === '/health'
    || ctx.path === '/ready'
    || ctx.path === '/metrics'
  ) {
    return true;
  }

  if (ctx.path.startsWith('/api/public/agents/')) {
    return true;
  }

  if (ctx.method === 'GET' && ctx.path === '/api/public/abuse/config') {
    return true;
  }

  if (ctx.method === 'GET' && ctx.path === '/api/public/plans') {
    return true;
  }

  if (ctx.path.startsWith('/api/public/privacy/') || ctx.path === '/api/public/analytics/events') {
    return true;
  }

  if (ctx.method === 'POST' && ctx.path === '/api/webhooks/stripe') {
    return true;
  }

  if (ctx.method === 'POST' && ctx.path === '/api/webhooks/email') {
    return true;
  }

  return [
    '/api/setup/status',
    '/api/setup/admin',
    '/api/auth/login',
    '/api/auth/mfa/verify',
    '/api/auth/register',
    '/api/auth/verify-email',
    '/api/auth/password/forgot',
    '/api/auth/password/reset',
    '/api/auth/logout',
    '/api/auth/session',
    '/api/invitations/accept',
  ].includes(ctx.path);
}

function isPendingEmailRequest(ctx: Koa.Context): boolean {
  return [
    '/api/auth/logout',
    '/api/auth/verification/resend',
  ].includes(ctx.path);
}

function parseCookie(cookieHeader: string): Record<string, string> {
  return cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((cookies, part) => {
      const separatorIndex = part.indexOf('=');
      if (separatorIndex === -1) {
        return cookies;
      }

      const name = part.slice(0, separatorIndex).trim();
      const value = part.slice(separatorIndex + 1).trim();
      try {
        cookies[name] = decodeURIComponent(value);
      } catch {
        cookies[name] = value;
      }
      return cookies;
    }, {});
}
