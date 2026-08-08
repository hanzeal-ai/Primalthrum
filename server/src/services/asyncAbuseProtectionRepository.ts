import { createHmac, randomUUID } from 'node:crypto';

import { type AsyncDatabaseAdapter } from '../db/asyncAdapter';
import {
  type AbuseProtectionStore,
  type ChallengeGrantInput,
  type ConsumeRateLimitInput,
  type RateLimitDecision,
  validateAbuseRule,
} from './abuseProtectionStore';

export class AsyncAbuseProtectionRepository implements AbuseProtectionStore {
  private operations = 0;

  constructor(
    private readonly database: AsyncDatabaseAdapter,
    private readonly hashSecret: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (Buffer.byteLength(hashSecret) < 32) throw new Error('abuse hash secret must be at least 32 bytes');
  }

  async consume(input: ConsumeRateLimitInput): Promise<RateLimitDecision> {
    validateAbuseRule(input.ruleKey, input.limit, input.windowMs);
    if (!input.subject) throw new Error('abuse rate limit subject is required');
    const now = this.now();
    const nowMs = now.getTime();
    const windowStartedAt = new Date(Math.floor(nowMs / input.windowMs) * input.windowMs).toISOString();
    const windowEndsAtMs = new Date(windowStartedAt).getTime() + input.windowMs;
    const subjectHash = this.hash(input.subject);
    const rows = await this.database.query<{ request_count: number }>({
      text: `
        INSERT INTO abuse_rate_limit_buckets (
          rule_key, subject_hash, window_started_at, window_ends_at, request_count, updated_at
        ) VALUES ($1, $2, $3, $4, 1, $5)
        ON CONFLICT(rule_key, subject_hash, window_started_at)
        DO UPDATE SET request_count = abuse_rate_limit_buckets.request_count + 1,
          updated_at = excluded.updated_at
        RETURNING request_count;
      `,
      values: [
        input.ruleKey,
        subjectHash,
        windowStartedAt,
        new Date(windowEndsAtMs).toISOString(),
        now.toISOString(),
      ],
    });
    const count = Number(rows[0]?.request_count ?? 1);
    this.operations += 1;
    if (this.operations % 100 === 0) await this.cleanup();
    return {
      allowed: count <= input.limit,
      count,
      limit: input.limit,
      remaining: Math.max(input.limit - count, 0),
      retryAfterSeconds: Math.max(1, Math.ceil((windowEndsAtMs - nowMs) / 1000)),
      subjectHash,
    };
  }

  async recordEnforcement(input: {
    ruleKey: string;
    action: string;
    subjectHash: string;
    outcome: 'rate_limited' | 'challenge_failed';
    retryAfterSeconds?: number;
    metadata?: Record<string, string | number | boolean>;
  }): Promise<void> {
    await this.database.execute({
      text: `
        INSERT INTO abuse_enforcement_events (
          event_id, rule_key, action, subject_hash, outcome,
          retry_after_seconds, metadata_json
        ) VALUES ($1, $2, $3, $4, $5, $6, $7);
      `,
      values: [
        randomUUID(), input.ruleKey, input.action, input.subjectHash, input.outcome,
        input.retryAfterSeconds ?? 0, JSON.stringify(input.metadata ?? {}),
      ],
    });
  }

  hash(subject: string): string {
    return createHmac('sha256', this.hashSecret).update(subject).digest('hex');
  }

  async hasChallengeGrant(input: ChallengeGrantInput): Promise<boolean> {
    const rows = await this.database.query<{ grant_hash: string }>({
      text: `
        SELECT grant_hash FROM abuse_challenge_grants
        WHERE grant_hash = $1 AND expires_at > $2 LIMIT 1;
      `,
      values: [this.challengeGrantHash(input), this.now().toISOString()],
    });
    return Boolean(rows[0]);
  }

  async grantChallenge(input: ChallengeGrantInput & { ttlMs?: number }): Promise<void> {
    const expiresAt = new Date(this.now().getTime() + (input.ttlMs ?? 10 * 60_000)).toISOString();
    await this.database.execute({
      text: `
        INSERT INTO abuse_challenge_grants (
          grant_hash, rule_key, subject_hash, expires_at
        ) VALUES ($1, $2, $3, $4)
        ON CONFLICT(grant_hash) DO UPDATE SET expires_at = excluded.expires_at;
      `,
      values: [
        this.challengeGrantHash(input), input.ruleKey, this.hash(input.subject), expiresAt,
      ],
    });
  }

  private async cleanup(): Promise<void> {
    const now = this.now();
    const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    await this.database.transaction(async (session) => {
      await session.execute({
        text: 'DELETE FROM abuse_rate_limit_buckets WHERE window_ends_at < $1;',
        values: [cutoff],
      });
      await session.execute({
        text: 'DELETE FROM abuse_challenge_grants WHERE expires_at < $1;',
        values: [now.toISOString()],
      });
    });
  }

  private challengeGrantHash(input: ChallengeGrantInput): string {
    return this.hash(`challenge:${input.ruleKey}:${input.subject}:${input.idempotencyKey}`);
  }
}
