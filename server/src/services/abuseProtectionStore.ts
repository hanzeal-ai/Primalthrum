import { type Awaitable } from './storeTypes';

export interface RateLimitDecision {
  allowed: boolean;
  count: number;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
  subjectHash: string;
}

export interface ConsumeRateLimitInput {
  ruleKey: string;
  subject: string;
  limit: number;
  windowMs: number;
}

export interface ChallengeGrantInput {
  ruleKey: string;
  subject: string;
  idempotencyKey: string;
}

export interface AbuseProtectionStore {
  consume(input: ConsumeRateLimitInput): Awaitable<RateLimitDecision>;
  recordEnforcement(input: {
    ruleKey: string;
    action: string;
    subjectHash: string;
    outcome: 'rate_limited' | 'challenge_failed';
    retryAfterSeconds?: number;
    metadata?: Record<string, string | number | boolean>;
  }): Awaitable<void>;
  hash(subject: string): string;
  hasChallengeGrant(input: ChallengeGrantInput): Awaitable<boolean>;
  grantChallenge(input: ChallengeGrantInput & { ttlMs?: number }): Awaitable<void>;
}

export function validateAbuseRule(ruleKey: string, limit: number, windowMs: number): void {
  if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(ruleKey)) throw new Error('abuse rule key is invalid');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000_000) {
    throw new Error('abuse rate limit is invalid');
  }
  if (!Number.isSafeInteger(windowMs) || windowMs < 1000 || windowMs > 7 * 24 * 60 * 60 * 1000) {
    throw new Error('abuse rate limit window is invalid');
  }
}
