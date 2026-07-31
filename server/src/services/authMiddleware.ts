import Koa from 'koa';

import {
  SessionRepository,
  type AuthenticatedSession,
} from './sessionRepository';

export const SESSION_COOKIE_NAME = 'primalthrum_session';

export interface AuthContextState {
  authSession?: AuthenticatedSession;
  sessionToken?: string;
}

export function createAuthMiddleware(
  sessions: SessionRepository,
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

    const session = sessions.findByToken(token);
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
    '/api/auth/register',
    '/api/auth/verify-email',
    '/api/auth/verification/resend',
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
