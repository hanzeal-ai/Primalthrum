import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { SqliteDatabase } from '../src/db/sqlite';
import { AccountEmailDispatcher } from '../src/services/accountEmailDispatcher';
import { AccountEmailOutboxRepository } from '../src/services/accountEmailOutboxRepository';
import {
  AccountEmailDeliveryError,
  HttpAccountEmailSender,
  ResendAccountEmailSender,
  type AccountEmailMessage,
} from '../src/services/accountEmailSender';
import { AccountTokenRepository } from '../src/services/accountTokenRepository';
import { hashPassword, verifyPasswordOrDummy } from '../src/services/passwordHash';
import { UserRepository } from '../src/services/userRepository';

let rootDir = '';
let db: SqliteDatabase;
let now: Date;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'primalthrum-account-identity-'));
  db = new SqliteDatabase(join(rootDir, 'platform.sqlite'));
  now = new Date('2026-08-15T12:00:00.000Z');
});

afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

test('account action tokens expire and can only be consumed once', () => {
  const user = new UserRepository(db).createUser('token@example.com', 'hash');
  const tokens = new AccountTokenRepository(db, () => now);
  const oneTime = tokens.create({ userId: user.id, purpose: 'verify_email', ttlMs: 1000 });
  assert.equal(tokens.consume(oneTime, 'reset_password'), null);
  assert.equal(tokens.consume(oneTime, 'verify_email')?.userId, user.id);
  assert.equal(tokens.consume(oneTime, 'verify_email'), null);

  const expiring = tokens.create({ userId: user.id, purpose: 'reset_password', ttlMs: 1000 });
  now = new Date('2026-08-15T12:00:01.001Z');
  assert.equal(tokens.consume(expiring, 'reset_password'), null);
});

test('login password checks use the same verifier path for missing accounts', () => {
  const encoded = hashPassword('correct horse battery staple');
  assert.equal(verifyPasswordOrDummy('correct horse battery staple', encoded), true);
  assert.equal(verifyPasswordOrDummy('a wrong long password', encoded), false);
  assert.equal(verifyPasswordOrDummy('a wrong long password', null), false);
});

test('email outbox records successful delivery once', async () => {
  const user = new UserRepository(db).createUser('delivery@example.com', 'hash');
  const outbox = new AccountEmailOutboxRepository(db, () => now);
  outbox.enqueue({ template: 'verify_email', recipientEmail: user.email,
    payload: { userId: user.id, actionUrl: 'https://app.test/verify' } });
  const delivered: AccountEmailMessage[] = [];
  const dispatcher = new AccountEmailDispatcher(outbox, {
    send: async (message) => {
      delivered.push(message);
      return { provider: 'test', providerMessageId: 'message-1' };
    },
  }, { log: () => undefined });
  await dispatcher.drain();
  await dispatcher.drain();
  assert.equal(delivered.length, 1);
  assert.deepEqual(db.query<{ status: string; attempts: number }>(`
    SELECT status, attempts FROM account_email_outbox;
  `), [{ status: 'delivered', attempts: 1 }]);
  assert.equal(db.query<{ payload_json: string }>(`
    SELECT payload_json FROM account_email_outbox;
  `)[0]?.payload_json, '{}');
});

test('email outbox retains failed delivery with retry evidence', async () => {
  const user = new UserRepository(db).createUser('retry@example.com', 'hash');
  const outbox = new AccountEmailOutboxRepository(db, () => now);
  outbox.enqueue({ template: 'reset_password', recipientEmail: user.email,
    payload: { userId: user.id, actionUrl: 'https://app.test/reset' } });
  const dispatcher = new AccountEmailDispatcher(outbox, {
    send: async () => { throw new Error('email service unavailable'); },
  }, { log: () => undefined });
  await dispatcher.drain();
  const row = db.query<{ status: string; attempts: number; last_error: string }>(`
    SELECT status, attempts, last_error FROM account_email_outbox;
  `)[0];
  assert.equal(row?.status, 'failed');
  assert.equal(row?.attempts, 1);
  assert.equal(row?.last_error, 'email service unavailable');
});

test('new account email supersedes an older undelivered link', () => {
  const user = new UserRepository(db).createUser('supersede@example.com', 'hash');
  const outbox = new AccountEmailOutboxRepository(db, () => now);
  outbox.enqueue({ template: 'verify_email', recipientEmail: user.email,
    payload: { userId: user.id, actionUrl: 'https://app.test/old' } });
  outbox.supersedePending(user.id, 'verify_email');
  outbox.enqueue({ template: 'verify_email', recipientEmail: user.email,
    payload: { userId: user.id, actionUrl: 'https://app.test/new' } });
  assert.deepEqual(db.query<{ status: string }>(`
    SELECT status FROM account_email_outbox ORDER BY id;
  `), [{ status: 'superseded' }, { status: 'pending' }]);
  assert.equal(db.query<{ payload_json: string }>(`
    SELECT payload_json FROM account_email_outbox ORDER BY id LIMIT 1;
  `)[0]?.payload_json, '{}');
});

test('HTTP email sender uses a stable provider idempotency contract', async () => {
  let request: RequestInit | undefined;
  const sender = new HttpAccountEmailSender(
    'https://email.example.com/messages', 'secret', 'Primalthrum <noreply@example.com>',
    async (_input, init) => {
      request = init;
      return Response.json({ id: 'provider-message-42' }, { status: 202 });
    },
  );
  const receipt = await sender.send({ id: 42, template: 'verify_email', recipientEmail: 'owner@example.com',
    payload: { userId: 7, actionUrl: 'https://app.test/verify' } });
  const headers = request?.headers as Record<string, string>;
  assert.equal(headers['Idempotency-Key'], 'primalthrum-account-email-42');
  assert.equal(headers.Authorization, 'Bearer secret');
  assert.equal(JSON.parse(String(request?.body)).from, 'Primalthrum <noreply@example.com>');
  assert.deepEqual(receipt, { provider: 'http', providerMessageId: 'provider-message-42' });
});

test('Resend sender renders account templates without exposing internal payload', async () => {
  let request: RequestInit | undefined;
  const sender = new ResendAccountEmailSender(
    're_secret',
    'Primalthrum <noreply@example.com>',
    async (_input, init) => {
      request = init;
      return Response.json({ id: 'resend-message-7' });
    },
  );
  const receipt = await sender.send({
    id: 7,
    template: 'reset_password',
    recipientEmail: 'owner@example.com',
    payload: { userId: 99, actionUrl: 'https://app.test/reset?token=secret' },
  });
  const body = JSON.parse(String(request?.body)) as Record<string, unknown>;
  assert.deepEqual(body.to, ['owner@example.com']);
  assert.match(String(body.subject), /重置/);
  assert.match(String(body.html), /https:\/\/app\.test\/reset\?token=secret/);
  assert.equal('userId' in body, false);
  assert.deepEqual(receipt, { provider: 'resend', providerMessageId: 'resend-message-7' });
});

test('email sender classifies rate limits as retryable and bad requests as permanent', async () => {
  const retryable = new ResendAccountEmailSender(
    're_secret', 'noreply@example.com',
    async () => Response.json({ message: 'slow down' }, {
      status: 429,
      headers: { 'retry-after': '30' },
    }),
  );
  await assert.rejects(
    retryable.send({ id: 1, template: 'verify_email', recipientEmail: 'a@example.com',
      payload: { actionUrl: 'https://app.test/verify' } }),
    (error: unknown) => error instanceof AccountEmailDeliveryError
      && error.retryable && error.retryAfterMs === 30_000,
  );

  const permanent = new ResendAccountEmailSender(
    're_secret', 'noreply@example.com',
    async () => Response.json({ message: 'invalid recipient' }, { status: 422 }),
  );
  await assert.rejects(
    permanent.send({ id: 2, template: 'verify_email', recipientEmail: 'b@example.com',
      payload: { actionUrl: 'https://app.test/verify' } }),
    (error: unknown) => error instanceof AccountEmailDeliveryError && !error.retryable,
  );
});

test('permanent delivery failures are dead-lettered without another retry', async () => {
  const user = new UserRepository(db).createUser('dead-letter@example.com', 'hash');
  const outbox = new AccountEmailOutboxRepository(db, () => now);
  outbox.enqueue({ template: 'verify_email', recipientEmail: user.email,
    payload: { userId: user.id, actionUrl: 'https://app.test/verify' } });
  const dispatcher = new AccountEmailDispatcher(outbox, {
    send: async () => { throw new AccountEmailDeliveryError('invalid recipient', false); },
  }, { log: () => undefined });
  await dispatcher.drain();
  assert.equal(outbox.claimNext(), null);
  const row = db.query<{ status: string; dead_lettered_at: string | null }>(`
    SELECT status, dead_lettered_at FROM account_email_outbox;
  `)[0];
  assert.equal(row?.status, 'failed');
  assert.ok(row?.dead_lettered_at);
  assert.equal(db.query<{ payload_json: string }>(`
    SELECT payload_json FROM account_email_outbox;
  `)[0]?.payload_json, '{}');
  assert.equal(outbox.summary().deadLettered, 1);
});
