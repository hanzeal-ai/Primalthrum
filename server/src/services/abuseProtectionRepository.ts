import { createHmac, randomUUID } from 'node:crypto';

import { initializeSchema } from '../db/schema';
import { SqliteDatabase, sqlValue } from '../db/sqlite';

export interface RateLimitDecision {
  allowed: boolean;
  count: number;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
  subjectHash: string;
}

export class AbuseProtectionRepository {
  private operations = 0;

  constructor(
    private readonly db: SqliteDatabase,
    private readonly hashSecret: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (Buffer.byteLength(hashSecret) < 32) throw new Error('abuse hash secret must be at least 32 bytes');
    initializeSchema(db);
  }

  consume(input: {
    ruleKey: string;
    subject: string;
    limit: number;
    windowMs: number;
  }): RateLimitDecision {
    validateRule(input.ruleKey, input.limit, input.windowMs);
    if (!input.subject) throw new Error('abuse rate limit subject is required');
    const nowMs = this.now().getTime();
    const windowStartedAt = new Date(Math.floor(nowMs / input.windowMs) * input.windowMs).toISOString();
    const windowEndsAtMs = new Date(windowStartedAt).getTime() + input.windowMs;
    const windowEndsAt = new Date(windowEndsAtMs).toISOString();
    const subjectHash = this.hash(input.subject);
    const row = this.db.query<{ request_count: number }>(`
      INSERT INTO abuse_rate_limit_buckets (
        rule_key, subject_hash, window_started_at, window_ends_at, request_count, updated_at
      ) VALUES (
        ${sqlValue(input.ruleKey)}, ${sqlValue(subjectHash)}, ${sqlValue(windowStartedAt)},
        ${sqlValue(windowEndsAt)}, 1, ${sqlValue(this.now().toISOString())}
      )
      ON CONFLICT(rule_key, subject_hash, window_started_at)
      DO UPDATE SET request_count = request_count + 1, updated_at = excluded.updated_at
      RETURNING request_count;
    `)[0];
    const count = Number(row?.request_count ?? 1);
    this.operations += 1;
    if (this.operations % 100 === 0) this.cleanup();
    return {
      allowed: count <= input.limit,
      count,
      limit: input.limit,
      remaining: Math.max(input.limit - count, 0),
      retryAfterSeconds: Math.max(1, Math.ceil((windowEndsAtMs - nowMs) / 1000)),
      subjectHash,
    };
  }

  recordEnforcement(input: {
    ruleKey: string;
    action: string;
    subjectHash: string;
    outcome: 'rate_limited' | 'challenge_failed';
    retryAfterSeconds?: number;
    metadata?: Record<string, string | number | boolean>;
  }): void {
    this.db.run(`
      INSERT INTO abuse_enforcement_events (
        event_id, rule_key, action, subject_hash, outcome,
        retry_after_seconds, metadata_json
      ) VALUES (
        ${sqlValue(randomUUID())}, ${sqlValue(input.ruleKey)}, ${sqlValue(input.action)},
        ${sqlValue(input.subjectHash)}, ${sqlValue(input.outcome)},
        ${sqlValue(input.retryAfterSeconds ?? 0)},
        ${sqlValue(JSON.stringify(input.metadata ?? {}))}
      );
    `);
  }

  hash(subject: string): string {
    return createHmac('sha256', this.hashSecret).update(subject).digest('hex');
  }

  hasChallengeGrant(input: { ruleKey: string; subject: string; idempotencyKey: string }): boolean {
    const grantHash = this.challengeGrantHash(input);
    return Boolean(this.db.query<{ grant_hash: string }>(`
      SELECT grant_hash FROM abuse_challenge_grants
      WHERE grant_hash = ${sqlValue(grantHash)}
        AND expires_at > ${sqlValue(this.now().toISOString())}
      LIMIT 1;
    `)[0]);
  }

  grantChallenge(input: {
    ruleKey: string;
    subject: string;
    idempotencyKey: string;
    ttlMs?: number;
  }): void {
    const grantHash = this.challengeGrantHash(input);
    const subjectHash = this.hash(input.subject);
    const expiresAt = new Date(this.now().getTime() + (input.ttlMs ?? 10 * 60_000)).toISOString();
    this.db.run(`
      INSERT INTO abuse_challenge_grants (
        grant_hash, rule_key, subject_hash, expires_at
      ) VALUES (
        ${sqlValue(grantHash)}, ${sqlValue(input.ruleKey)},
        ${sqlValue(subjectHash)}, ${sqlValue(expiresAt)}
      )
      ON CONFLICT(grant_hash) DO UPDATE SET expires_at = excluded.expires_at;
    `);
  }

  private cleanup(): void {
    const cutoff = new Date(this.now().getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    this.db.run(`
      DELETE FROM abuse_rate_limit_buckets
      WHERE window_ends_at < ${sqlValue(cutoff)};
      DELETE FROM abuse_challenge_grants
      WHERE expires_at < ${sqlValue(this.now().toISOString())};
    `);
  }

  private challengeGrantHash(input: {
    ruleKey: string;
    subject: string;
    idempotencyKey: string;
  }): string {
    return this.hash(`challenge:${input.ruleKey}:${input.subject}:${input.idempotencyKey}`);
  }
}

function validateRule(ruleKey: string, limit: number, windowMs: number): void {
  if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(ruleKey)) throw new Error('abuse rule key is invalid');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000_000) {
    throw new Error('abuse rate limit is invalid');
  }
  if (!Number.isSafeInteger(windowMs) || windowMs < 1000 || windowMs > 7 * 24 * 60 * 60 * 1000) {
    throw new Error('abuse rate limit window is invalid');
  }
}
