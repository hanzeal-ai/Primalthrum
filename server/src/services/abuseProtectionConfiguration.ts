import {
  TurnstileBotChallengeVerifier,
  type BotChallengeVerifier,
} from './botChallengeVerifier';

const DEVELOPMENT_HASH_SECRET = 'primalthrum-development-abuse-hash-secret';

export interface AbuseProtectionConfiguration {
  hashSecret: string;
  trustedProxyHops: number;
  botChallengeVerifier?: BotChallengeVerifier;
  botChallengeSiteKey?: string;
}

export function createAbuseProtectionConfiguration(
  environment: Record<string, string | undefined>,
  fetchImplementation: typeof fetch = fetch,
): AbuseProtectionConfiguration {
  const production = environment.NODE_ENV === 'production';
  const hashSecret = environment.ABUSE_HASH_SECRET?.trim() || (production ? '' : DEVELOPMENT_HASH_SECRET);
  if (Buffer.byteLength(hashSecret) < 32) {
    throw new Error('ABUSE_HASH_SECRET must be at least 32 bytes');
  }
  const trustedProxyHops = integer(environment.TRUSTED_PROXY_HOPS ?? '0', 'TRUSTED_PROXY_HOPS', 0, 10);
  const provider = environment.BOT_CHALLENGE_PROVIDER?.trim().toLowerCase();
  if (!provider) {
    if (production) throw new Error('BOT_CHALLENGE_PROVIDER is required in production');
    return { hashSecret, trustedProxyHops };
  }
  if (provider !== 'turnstile') throw new Error('BOT_CHALLENGE_PROVIDER must be turnstile');
  const secretKey = required(environment.TURNSTILE_SECRET_KEY, 'TURNSTILE_SECRET_KEY');
  const siteKey = required(environment.TURNSTILE_SITE_KEY, 'TURNSTILE_SITE_KEY');
  const hostnames = new Set(
    required(environment.TURNSTILE_HOSTNAMES, 'TURNSTILE_HOSTNAMES')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  if (production && ['localhost', '127.0.0.1', '::1'].some((value) => hostnames.has(value))) {
    throw new Error('TURNSTILE_HOSTNAMES cannot contain local hosts in production');
  }
  return {
    hashSecret,
    trustedProxyHops,
    botChallengeSiteKey: siteKey,
    botChallengeVerifier: new TurnstileBotChallengeVerifier(
      secretKey,
      hostnames,
      fetchImplementation,
      environment.TURNSTILE_VERIFY_URL?.trim() || undefined,
    ),
  };
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function integer(value: string, name: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}
