import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { createApp } from '../src/app';
import { SqliteDatabase } from '../src/db/sqlite';
import { createSqliteDatabase } from '../src/db/databaseFactory';
import { AbuseProtectionService, type AbusePolicy } from '../src/services/abuseProtection';
import { createAbuseProtectionConfiguration } from '../src/services/abuseProtectionConfiguration';
import { AbuseProtectionRepository } from '../src/services/abuseProtectionRepository';
import { TurnstileBotChallengeVerifier } from '../src/services/botChallengeVerifier';
import { resolveClientAddress } from '../src/services/clientAddress';

const HASH_SECRET = 'test-abuse-protection-hash-secret-32-bytes';
const NOW = new Date('2026-08-15T12:00:00.000Z');
let rootDir = '';
let dbPath = '';
let server: Server;
let baseUrl = '';
let challengeVerifications = 0;

before(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'primalthrum-abuse-'));
  dbPath = join(rootDir, 'platform.sqlite');
  const repository = new AbuseProtectionRepository(createSqliteDatabase(dbPath), HASH_SECRET, () => NOW);
  const policies: AbusePolicy[] = [
    {
      key: 'test_login',
      action: 'auth_login',
      method: 'POST',
      path: /^\/api\/auth\/login$/,
      limits: [{ scope: 'ip', limit: 2, windowMs: 60_000 }],
    },
    {
      key: 'test_register',
      action: 'auth_register',
      method: 'POST',
      path: /^\/api\/auth\/register$/,
      challenge: true,
      limits: [{ scope: 'ip', limit: 10, windowMs: 60_000 }],
    },
    {
      key: 'test_public_stream',
      action: 'public_agent_stream',
      method: 'POST',
      path: /^\/api\/public\/agents\/[^/]+\/stream$/,
      challenge: true,
      limits: [{ scope: 'ip', limit: 10, windowMs: 60_000 }],
    },
  ];
  const abuseProtection = new AbuseProtectionService(
    repository,
    { verify: async ({ token }) => {
      challengeVerifications += 1;
      return token === 'valid-challenge-token'
        ? { success: true }
        : { success: false, reason: 'test rejection' };
    } },
    0,
    policies,
  );
  server = createApp({
    dbPath,
    documentStorageDir: join(rootDir, 'documents'),
    generatedAgentsDir: join(rootDir, 'agents'),
    abuseProtection,
    logger: { log: () => undefined },
  }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(rootDir, { recursive: true, force: true });
});

test('rate limit buckets are atomic, reset by window, and store only HMAC subjects', () => {
  let now = NOW;
  const db = createSqliteDatabase(join(rootDir, 'repository.sqlite'));
  const repository = new AbuseProtectionRepository(db, HASH_SECRET, () => now);
  assert.equal(repository.consume({ ruleKey: 'login.ip', subject: 'ip:203.0.113.8', limit: 2, windowMs: 60_000 }).allowed, true);
  assert.equal(repository.consume({ ruleKey: 'login.ip', subject: 'ip:203.0.113.8', limit: 2, windowMs: 60_000 }).allowed, true);
  const blocked = repository.consume({ ruleKey: 'login.ip', subject: 'ip:203.0.113.8', limit: 2, windowMs: 60_000 });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  assert.equal(repository.consume({ ruleKey: 'login.ip', subject: 'ip:203.0.113.9', limit: 2, windowMs: 60_000 }).allowed, true);
  now = new Date(NOW.getTime() + 60_001);
  assert.equal(repository.consume({ ruleKey: 'login.ip', subject: 'ip:203.0.113.8', limit: 2, windowMs: 60_000 }).allowed, true);
  const stored = db.query<{ subject_hash: string }>('SELECT subject_hash FROM abuse_rate_limit_buckets;');
  assert.ok(stored.every((row) => /^[a-f0-9]{64}$/.test(row.subject_hash)));
  assert.equal(JSON.stringify(stored).includes('203.0.113.8'), false);
});

test('untrusted forwarded addresses cannot evade the HTTP rate limit', async () => {
  const attempt = (forwardedFor: string) => fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': forwardedFor },
    body: JSON.stringify({ email: 'missing@example.com', password: 'a wrong long password' }),
  });
  assert.equal((await attempt('203.0.113.1')).status, 401);
  assert.equal((await attempt('203.0.113.2')).status, 401);
  const blocked = await attempt('203.0.113.3');
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('retry-after'), '60');
  assert.equal(blocked.headers.get('x-ratelimit-remaining'), '0');
  const payload = await blocked.json() as { error: { code: string; details: { retryAfterSeconds: number } } };
  assert.equal(payload.error.code, 'RATE_LIMIT_EXCEEDED');
  assert.equal(payload.error.details.retryAfterSeconds, 60);
});

test('registration challenge is verified before business logic', async () => {
  const request = (token = '') => fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-bot-challenge-token': token } : {}),
    },
    body: JSON.stringify({ email: 'invalid', password: '', workspaceName: '', planKey: 'pro' }),
  });
  assert.equal((await request()).status, 403);
  assert.equal((await request('invalid-token-value')).status, 403);
  assert.equal((await request('valid-challenge-token')).status, 400);
  const db = createSqliteDatabase(dbPath);
  assert.equal(db.query<{ count: number }>(`
    SELECT COUNT(*) AS count FROM abuse_enforcement_events
    WHERE outcome = 'challenge_failed';
  `)[0]?.count, 2);
  assert.throws(
    () => db.run("DELETE FROM abuse_enforcement_events WHERE outcome = 'challenge_failed';"),
    /abuse enforcement events are immutable/,
  );
});

test('public stream retries reuse a short-lived challenge grant bound to the idempotency key', async () => {
  const before = challengeVerifications;
  const request = (token: string, idempotencyKey: string) => fetch(
    `${baseUrl}/api/public/agents/missing/stream`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
        ...(token ? { 'x-bot-challenge-token': token } : {}),
      },
      body: JSON.stringify({ input: 'hello' }),
    },
  );
  assert.equal((await request('valid-challenge-token', 'public-run-1')).status, 404);
  assert.equal((await request('', 'public-run-1')).status, 404);
  assert.equal(challengeVerifications, before + 1);
  assert.equal((await request('', 'public-run-2')).status, 403);
});

test('public abuse config defaults to disabled without exposing secrets', async () => {
  const response = await fetch(`${baseUrl}/api/public/abuse/config`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { provider: 'disabled', siteKey: '', actions: [] });
});

test('abuse enforcement exports bounded Prometheus labels', async () => {
  const metrics = await fetch(`${baseUrl}/metrics`).then((response) => response.text());
  assert.match(metrics, /primalthrum_abuse_enforcement_total\{outcome="rate_limited",rule="test_login"\} 1/);
  assert.match(metrics, /primalthrum_abuse_enforcement_total\{outcome="challenge_failed",rule="test_register"\} 2/);
  assert.doesNotMatch(metrics, /missing@example\.com|127\.0\.0\.1/);
});

test('trusted proxy parsing selects the first untrusted hop only', () => {
  assert.equal(resolveClientAddress({
    remoteAddress: '10.0.0.3', forwardedFor: '198.51.100.7, 10.0.0.2', trustedProxyHops: 2,
  }), '198.51.100.7');
  assert.equal(resolveClientAddress({
    remoteAddress: '10.0.0.3', forwardedFor: '198.51.100.7', trustedProxyHops: 0,
  }), '10.0.0.3');
  assert.equal(resolveClientAddress({
    remoteAddress: '10.0.0.3', forwardedFor: 'spoofed', trustedProxyHops: 1,
  }), '10.0.0.3');
});

test('Turnstile verifier binds tokens to action, hostname, timestamp, and remote IP', async () => {
  let requestBody = '';
  const verifier = new TurnstileBotChallengeVerifier(
    'turnstile-secret',
    new Set(['app.example.com']),
    async (_input, init) => {
      requestBody = String(init?.body);
      return Response.json({
        success: true,
        action: 'auth_register',
        hostname: 'app.example.com',
        challenge_ts: NOW.toISOString(),
      });
    },
    'https://turnstile.test/siteverify',
    () => NOW,
  );
  assert.deepEqual(await verifier.verify({
    token: 'challenge-token-value', remoteIp: '198.51.100.8', action: 'auth_register',
  }), { success: true });
  const params = new URLSearchParams(requestBody);
  assert.equal(params.get('secret'), 'turnstile-secret');
  assert.equal(params.get('response'), 'challenge-token-value');
  assert.equal(params.get('remoteip'), '198.51.100.8');

  const mismatch = new TurnstileBotChallengeVerifier(
    'turnstile-secret', new Set(['app.example.com']),
    async () => Response.json({
      success: true, action: 'public_agent_stream', hostname: 'other.example.com',
      challenge_ts: NOW.toISOString(),
    }),
    'https://turnstile.test/siteverify', () => NOW,
  );
  assert.equal((await mismatch.verify({
    token: 'challenge-token-value', remoteIp: '198.51.100.8', action: 'auth_register',
  })).success, false);
});

test('production abuse configuration fails closed', () => {
  assert.throws(() => createAbuseProtectionConfiguration({ NODE_ENV: 'production' }), /ABUSE_HASH_SECRET/);
  assert.throws(() => createAbuseProtectionConfiguration({
    NODE_ENV: 'production', ABUSE_HASH_SECRET: HASH_SECRET,
  }), /BOT_CHALLENGE_PROVIDER/);
  assert.throws(() => createAbuseProtectionConfiguration({
    NODE_ENV: 'production',
    ABUSE_HASH_SECRET: HASH_SECRET,
    BOT_CHALLENGE_PROVIDER: 'turnstile',
    TURNSTILE_SITE_KEY: 'site-key',
    TURNSTILE_SECRET_KEY: 'turnstile-secret',
    TURNSTILE_HOSTNAMES: 'localhost',
  }), /local hosts/);
  const configured = createAbuseProtectionConfiguration({
    NODE_ENV: 'production',
    ABUSE_HASH_SECRET: HASH_SECRET,
    TRUSTED_PROXY_HOPS: '1',
    BOT_CHALLENGE_PROVIDER: 'turnstile',
    TURNSTILE_SITE_KEY: 'site-key',
    TURNSTILE_SECRET_KEY: 'turnstile-secret',
    TURNSTILE_HOSTNAMES: 'app.example.com,www.example.com',
  });
  assert.equal(configured.trustedProxyHops, 1);
  assert.ok(configured.botChallengeVerifier);
});
