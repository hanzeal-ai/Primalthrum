import Router from '@koa/router';
import type Koa from 'koa';

import { sendApiError } from '../services/apiErrors';
import { sessionCookie } from '../services/authMiddleware';
import { type StructuredLogger } from '../services/logger';
import {
  type MfaAuthenticationMethod,
  type MfaChallengePurpose,
} from '../services/mfaRepository';
import { MfaService, MfaVerificationError } from '../services/mfaService';
import { verifyPassword } from '../services/passwordHash';
import { type SessionStore } from '../services/sessionStore';
import { type Awaitable } from '../services/storeTypes';
import { type PublicUserRecord, type UserRecord } from '../services/userRepository';
import { type UserStore } from '../services/userStore';

interface CompletedMfaChallenge {
  user: PublicUserRecord;
  emailVerified: boolean;
  status?: number;
}

interface MfaRouteDependencies {
  completeChallenge: (input: {
    userId: number;
    purpose: MfaChallengePurpose;
    context: Record<string, unknown>;
    authenticationMethod: MfaAuthenticationMethod;
  }) => Awaitable<CompletedMfaChallenge>;
  currentUserId: (ctx: Koa.Context) => number;
  logger: StructuredLogger;
  mfa: MfaService;
  sessions: SessionStore;
  users: UserStore;
}

export function registerMfaRoutes(
  router: Router,
  dependencies: MfaRouteDependencies,
): void {
  const { completeChallenge, currentUserId, logger, mfa, sessions, users } = dependencies;

  router.get('/api/settings/mfa', (ctx) => {
    ctx.body = mfa.status(currentUserId(ctx));
  });

  router.post('/api/settings/mfa/setup', async (ctx) => {
    const user = await requireCurrentPassword(ctx, currentUserId(ctx), users, logger);
    if (!user) return;
    try {
      ctx.status = 201;
      ctx.body = mfa.beginSetup({
        userId: user.id,
        secretWorkspaceId: user.workspaceId,
        email: user.email,
      });
    } catch (error) {
      sendMfaError(ctx, logger, error, 'failed to start MFA setup');
    }
  });

  router.post('/api/settings/mfa/confirm', async (ctx) => {
    const userId = currentUserId(ctx);
    const token = ctx.state.sessionToken;
    if (!token) return sessionRequired(ctx, logger);
    try {
      const body = ctx.request.body as Record<string, unknown>;
      const result = mfa.confirmSetup(userId, body.code);
      await sessions.markMfaAuthenticated(token, userId);
      await sessions.revokeOthers(userId, token);
      ctx.body = { ...result, ...mfa.status(userId) };
    } catch (error) {
      sendMfaError(ctx, logger, error, 'failed to confirm MFA setup');
    }
  });

  router.post('/api/settings/mfa/recovery-codes', async (ctx) => {
    const userId = currentUserId(ctx);
    if (!await requireCurrentPassword(ctx, userId, users, logger)) return;
    try {
      const body = ctx.request.body as Record<string, unknown>;
      ctx.body = mfa.regenerateRecoveryCodes(userId, body.code);
    } catch (error) {
      sendMfaError(ctx, logger, error, 'failed to regenerate recovery codes');
    }
  });

  router.delete('/api/settings/mfa', async (ctx) => {
    const userId = currentUserId(ctx);
    const token = ctx.state.sessionToken;
    if (!token) return sessionRequired(ctx, logger);
    if (!await requireCurrentPassword(ctx, userId, users, logger)) return;
    try {
      const body = ctx.request.body as Record<string, unknown>;
      mfa.disable(userId, body.code);
      await sessions.revokeOthers(userId, token);
      await sessions.markPasswordAuthenticated(token, userId);
      ctx.status = 204;
    } catch (error) {
      sendMfaError(ctx, logger, error, 'failed to disable MFA');
    }
  });

  router.post('/api/auth/mfa/verify', async (ctx) => {
    try {
      const body = ctx.request.body as Record<string, unknown>;
      const verified = mfa.verifyChallenge(body.challengeToken, body.code);
      const completed = await completeChallenge(verified);
      const session = await sessions.create(completed.user, verified.authenticationMethod);
      ctx.set('Set-Cookie', sessionCookie(session.token, session.expiresAt));
      ctx.status = completed.status ?? 200;
      ctx.body = {
        user: completed.user,
        session,
        emailVerified: completed.emailVerified,
      };
    } catch (error) {
      sendMfaError(ctx, logger, error, 'failed to verify MFA challenge');
    }
  });
}

async function requireCurrentPassword(
  ctx: Koa.Context,
  userId: number,
  users: UserStore,
  logger: StructuredLogger,
): Promise<UserRecord | null> {
  const body = ctx.request.body as Record<string, unknown>;
  const password = typeof body.password === 'string' ? body.password : '';
  const user = await users.findById(userId);
  if (user && verifyPassword(password, user.passwordHash)) return user;
  sendApiError(ctx, logger, {
    status: 401,
    code: 'REAUTHENTICATION_REQUIRED',
    message: 'current password is required',
  });
  return null;
}

function sessionRequired(ctx: Koa.Context, logger: StructuredLogger): void {
  sendApiError(ctx, logger, {
    status: 401,
    code: 'AUTHENTICATION_REQUIRED',
    message: 'browser session authentication is required',
  });
}

function sendMfaError(
  ctx: Koa.Context,
  logger: StructuredLogger,
  error: unknown,
  fallback: string,
): void {
  sendApiError(ctx, logger, {
    status: error instanceof MfaVerificationError ? 401 : 400,
    code: error instanceof MfaVerificationError ? 'MFA_CODE_INVALID' : 'MFA_INVALID',
    message: error instanceof Error ? error.message : fallback,
  });
}
