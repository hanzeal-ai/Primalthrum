import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { SqliteDatabase } from '../src/db/sqlite';
import { AccountEmailDispatcher } from '../src/services/accountEmailDispatcher';
import { AccountEmailOutboxRepository } from '../src/services/accountEmailOutboxRepository';
import { HttpAccountEmailSender, type AccountEmailMessage } from '../src/services/accountEmailSender';
import { AccountTokenRepository } from '../src/services/accountTokenRepository';
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

test('email outbox records successful delivery once', async () => {
  const user = new UserRepository(db).createUser('delivery@example.com', 'hash');
  const outbox = new AccountEmailOutboxRepository(db, () => now);
  outbox.enqueue({ template: 'verify_email', recipientEmail: user.email,
    payload: { userId: user.id, actionUrl: 'https://app.test/verify' } });
  const delivered: AccountEmailMessage[] = [];
  const dispatcher = new AccountEmailDispatcher(outbox, {
    send: async (message) => { delivered.push(message); },
  }, { log: () => undefined });
  await dispatcher.drain();
  await dispatcher.drain();
  assert.equal(delivered.length, 1);
  assert.deepEqual(db.query<{ status: string; attempts: number }>(`
    SELECT status, attempts FROM account_email_outbox;
  `), [{ status: 'delivered', attempts: 1 }]);
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
});

test('HTTP email sender uses a stable provider idempotency contract', async () => {
  let request: RequestInit | undefined;
  const sender = new HttpAccountEmailSender(
    'https://email.example.com/messages', 'secret', 'Primalthrum <noreply@example.com>',
    async (_input, init) => { request = init; return new Response(null, { status: 202 }); },
  );
  await sender.send({ id: 42, template: 'verify_email', recipientEmail: 'owner@example.com',
    payload: { userId: 7, actionUrl: 'https://app.test/verify' } });
  const headers = request?.headers as Record<string, string>;
  assert.equal(headers['Idempotency-Key'], 'primalthrum-account-email-42');
  assert.equal(headers.Authorization, 'Bearer secret');
  assert.equal(JSON.parse(String(request?.body)).from, 'Primalthrum <noreply@example.com>');
});
