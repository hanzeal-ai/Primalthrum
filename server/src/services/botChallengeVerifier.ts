import { randomUUID } from 'node:crypto';

export interface BotChallengeResult {
  success: boolean;
  reason?: string;
}

export interface BotChallengeVerifier {
  verify(input: { token: string; remoteIp: string; action: string }): Promise<BotChallengeResult>;
}

export class BotChallengeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BotChallengeUnavailableError';
  }
}

export class TurnstileBotChallengeVerifier implements BotChallengeVerifier {
  constructor(
    private readonly secretKey: string,
    private readonly allowedHostnames: ReadonlySet<string>,
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly endpoint = 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    private readonly now: () => Date = () => new Date(),
    private readonly timeoutMs = 5000,
  ) {
    if (!secretKey.trim()) throw new Error('Turnstile secret key is required');
    if (!allowedHostnames.size) throw new Error('Turnstile allowed hostnames are required');
    new URL(endpoint);
  }

  async verify(input: { token: string; remoteIp: string; action: string }): Promise<BotChallengeResult> {
    if (input.token.length < 10 || input.token.length > 2048) {
      return { success: false, reason: 'challenge token is invalid' };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const body = new URLSearchParams({
        secret: this.secretKey,
        response: input.token,
        remoteip: input.remoteIp,
        idempotency_key: randomUUID(),
      });
      const response = await this.fetchImplementation(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: controller.signal,
      });
      if (!response.ok) throw new BotChallengeUnavailableError(`Turnstile returned HTTP ${response.status}`);
      const payload = await response.json() as Record<string, unknown>;
      if (payload.success !== true) return { success: false, reason: errorReason(payload['error-codes']) };
      if (payload.action !== input.action) return { success: false, reason: 'challenge action mismatch' };
      if (typeof payload.hostname !== 'string'
        || !this.allowedHostnames.has(payload.hostname.toLowerCase())) {
        return { success: false, reason: 'challenge hostname mismatch' };
      }
      const challengedAt = typeof payload.challenge_ts === 'string'
        ? new Date(payload.challenge_ts).getTime()
        : Number.NaN;
      const ageMs = this.now().getTime() - challengedAt;
      if (!Number.isFinite(ageMs) || ageMs < -60_000 || ageMs > 5 * 60_000) {
        return { success: false, reason: 'challenge timestamp is invalid' };
      }
      return { success: true };
    } catch (error) {
      if (error instanceof BotChallengeUnavailableError) throw error;
      throw new BotChallengeUnavailableError(
        error instanceof Error && error.name === 'AbortError'
          ? 'Turnstile verification timed out'
          : error instanceof Error ? error.message : 'Turnstile verification failed',
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

function errorReason(value: unknown): string {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').slice(0, 3).join(',')
      || 'challenge rejected'
    : 'challenge rejected';
}
