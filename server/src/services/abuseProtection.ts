import { createHash } from 'node:crypto';

import type Koa from 'koa';

import { sendApiError } from './apiErrors';
import { AbuseProtectionRepository, type RateLimitDecision } from './abuseProtectionRepository';
import {
  BotChallengeUnavailableError,
  type BotChallengeVerifier,
} from './botChallengeVerifier';
import { resolveClientAddress } from './clientAddress';
import { type StructuredLogger } from './logger';
import { type MetricsRegistry } from './metricsRegistry';

type SubjectScope = 'ip' | 'identity' | 'user' | 'resource' | 'token';

export interface AbusePolicy {
  key: string;
  action: string;
  method: string;
  path: RegExp;
  challenge?: boolean;
  limits: Array<{ scope: SubjectScope; limit: number; windowMs: number }>;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const DEFAULT_ABUSE_POLICIES: readonly AbusePolicy[] = [
  policy('setup_admin', 'setup_admin', 'POST', /^\/api\/setup\/admin$/, [ip(3, HOUR)]),
  policy('auth_login', 'auth_login', 'POST', /^\/api\/auth\/login$/, [ip(30, 10 * MINUTE), identity(10, 10 * MINUTE)]),
  policy('auth_register', 'auth_register', 'POST', /^\/api\/auth\/register$/, [ip(5, HOUR), identity(3, DAY)], true),
  policy('verify_email', 'verify_email', 'POST', /^\/api\/auth\/verify-email$/, [ip(20, 15 * MINUTE)]),
  policy('verification_resend', 'verification_resend', 'POST', /^\/api\/auth\/verification\/resend$/, [ip(10, HOUR), user(5, HOUR)]),
  policy('password_forgot', 'password_forgot', 'POST', /^\/api\/auth\/password\/forgot$/, [ip(10, HOUR), identity(3, HOUR)]),
  policy('password_reset', 'password_reset', 'POST', /^\/api\/auth\/password\/reset$/, [ip(10, HOUR)]),
  policy('invitation_accept', 'invitation_accept', 'POST', /^\/api\/invitations\/accept$/, [ip(20, 15 * MINUTE), token(10, 15 * MINUTE)]),
  policy('api_key_create', 'api_key_create', 'POST', /^\/api\/settings\/api-keys$/, [user(10, HOUR)]),
  policy('privacy_consent', 'privacy_consent', 'POST', /^\/api\/public\/privacy\/consents$/, [ip(30, MINUTE)]),
  policy('analytics_event', 'analytics_event', 'POST', /^\/api\/public\/analytics\/events$/, [ip(120, MINUTE)]),
  policy('public_agent_read', 'public_agent_read', 'GET', /^\/api\/public\/agents\/[^/]+$/, [ip(120, MINUTE)]),
  policy('public_agent_stream', 'public_agent_stream', 'POST', /^\/api\/public\/agents\/[^/]+\/stream$/, [ip(10, MINUTE), resource(30, HOUR)], true),
  policy('authenticated_stream', 'authenticated_stream', 'POST', /^\/api\/stream(?:\/create-agent)?$/, [user(120, HOUR)]),
  policy('document_upload', 'document_upload', 'POST', /^\/api\/agents\/\d+\/documents(?:\/upload)?$/, [user(30, HOUR)]),
  policy('speech', 'speech', 'POST', /^\/api\/speech\/(?:transcriptions|synthesis)$/, [user(120, HOUR)]),
];

export class AbuseProtectionService {
  constructor(
    private readonly repository: AbuseProtectionRepository,
    private readonly botChallengeVerifier: BotChallengeVerifier | undefined,
    private readonly trustedProxyHops: number,
    private readonly policies: readonly AbusePolicy[] = DEFAULT_ABUSE_POLICIES,
  ) {}

  async enforce(
    ctx: Koa.Context,
    logger: StructuredLogger,
    metrics: MetricsRegistry,
  ): Promise<boolean> {
    const selected = this.policies.find((candidate) => (
      candidate.method === ctx.method && candidate.path.test(ctx.path)
    ));
    if (!selected) return true;
    const clientIp = resolveClientAddress({
      remoteAddress: ctx.req.socket.remoteAddress,
      forwardedFor: ctx.get('x-forwarded-for'),
      trustedProxyHops: this.trustedProxyHops,
    });
    const decisions = selected.limits.map((limit) => this.repository.consume({
      ruleKey: `${selected.key}.${limit.scope}`,
      subject: subjectFor(ctx, clientIp, limit.scope),
      limit: limit.limit,
      windowMs: limit.windowMs,
    }));
    setRateLimitHeaders(ctx, decisions);
    const blocked = decisions
      .filter((decision) => !decision.allowed)
      .sort((left, right) => right.retryAfterSeconds - left.retryAfterSeconds)[0];
    if (blocked) {
      this.repository.recordEnforcement({
        ruleKey: selected.key,
        action: selected.action,
        subjectHash: blocked.subjectHash,
        outcome: 'rate_limited',
        retryAfterSeconds: blocked.retryAfterSeconds,
        metadata: { method: ctx.method },
      });
      metrics.observeAbuse(selected.key, 'rate_limited');
      ctx.set('Retry-After', String(blocked.retryAfterSeconds));
      sendApiError(ctx, logger, {
        status: 429,
        code: 'RATE_LIMIT_EXCEEDED',
        message: '请求过于频繁，请稍后重试。',
        details: { retryAfterSeconds: blocked.retryAfterSeconds },
      });
      return false;
    }
    if (!selected.challenge || !this.botChallengeVerifier) return true;
    const challengeGrant = selected.action === 'public_agent_stream'
      ? challengeGrantInput(ctx, selected.key, clientIp)
      : null;
    if (challengeGrant && this.repository.hasChallengeGrant(challengeGrant)) return true;
    const challengeToken = ctx.get('x-bot-challenge-token');
    try {
      const result = await this.botChallengeVerifier.verify({
        token: challengeToken,
        remoteIp: clientIp,
        action: selected.action,
      });
      if (result.success) {
        if (challengeGrant) this.repository.grantChallenge(challengeGrant);
        return true;
      }
      this.repository.recordEnforcement({
        ruleKey: selected.key,
        action: selected.action,
        subjectHash: this.repository.hash(`ip:${clientIp}`),
        outcome: 'challenge_failed',
        metadata: { reason: (result.reason ?? 'rejected').slice(0, 120) },
      });
      metrics.observeAbuse(selected.key, 'challenge_failed');
      sendApiError(ctx, logger, {
        status: 403,
        code: 'BOT_CHALLENGE_REQUIRED',
        message: '请完成人机验证后重试。',
      });
      return false;
    } catch (error) {
      metrics.observeAbuse(selected.key, 'challenge_unavailable');
      sendApiError(ctx, logger, {
        status: error instanceof BotChallengeUnavailableError ? 503 : 403,
        code: error instanceof BotChallengeUnavailableError
          ? 'BOT_CHALLENGE_UNAVAILABLE'
          : 'BOT_CHALLENGE_REQUIRED',
        message: error instanceof BotChallengeUnavailableError
          ? '人机验证服务暂时不可用，请稍后重试。'
          : '请完成人机验证后重试。',
      });
      return false;
    }
  }
}

function subjectFor(ctx: Koa.Context, clientIp: string, scope: SubjectScope): string {
  if (scope === 'ip') return `ip:${clientIp}`;
  if (scope === 'identity') {
    const body = ctx.request.body as Record<string, unknown> | undefined;
    const value = typeof body?.email === 'string'
      ? body.email.trim().toLowerCase().slice(0, 254)
      : 'missing';
    return `identity:${value || 'missing'}`;
  }
  if (scope === 'resource') return `resource:${clientIp}:${ctx.path.toLowerCase()}`;
  if (scope === 'token') {
    const body = ctx.request.body as Record<string, unknown> | undefined;
    const value = typeof body?.token === 'string' ? body.token.slice(0, 512) : 'missing';
    return `token:${createHash('sha256').update(value || 'missing').digest('hex')}`;
  }
  const apiKeyId = Number(ctx.state.apiKey?.id);
  if (Number.isSafeInteger(apiKeyId) && apiKeyId > 0) return `api_key:${apiKeyId}`;
  const userId = Number(ctx.state.authSession?.user.id);
  return Number.isSafeInteger(userId) && userId > 0 ? `user:${userId}` : `user:anonymous:${clientIp}`;
}

function setRateLimitHeaders(ctx: Koa.Context, decisions: RateLimitDecision[]): void {
  if (!decisions.length) return;
  ctx.set('X-RateLimit-Limit', String(Math.min(...decisions.map((item) => item.limit))));
  ctx.set('X-RateLimit-Remaining', String(Math.min(...decisions.map((item) => item.remaining))));
  ctx.set('X-RateLimit-Reset', String(Math.max(...decisions.map((item) => item.retryAfterSeconds))));
}

function challengeGrantInput(
  ctx: Koa.Context,
  ruleKey: string,
  clientIp: string,
): { ruleKey: string; subject: string; idempotencyKey: string } | null {
  const idempotencyKey = ctx.get('idempotency-key').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(idempotencyKey)) return null;
  return { ruleKey, subject: `ip:${clientIp}`, idempotencyKey };
}

function policy(
  key: string,
  action: string,
  method: string,
  path: RegExp,
  limits: AbusePolicy['limits'],
  challenge = false,
): AbusePolicy {
  return { key, action, method, path, limits, challenge };
}

function ip(limit: number, windowMs: number) { return { scope: 'ip' as const, limit, windowMs }; }
function identity(limit: number, windowMs: number) { return { scope: 'identity' as const, limit, windowMs }; }
function user(limit: number, windowMs: number) { return { scope: 'user' as const, limit, windowMs }; }
function resource(limit: number, windowMs: number) { return { scope: 'resource' as const, limit, windowMs }; }
function token(limit: number, windowMs: number) { return { scope: 'token' as const, limit, windowMs }; }
