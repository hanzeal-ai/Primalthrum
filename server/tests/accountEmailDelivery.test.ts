import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { createApp } from '../src/app';
import { SqliteDatabase } from '../src/db/sqlite';
import { createAccountEmailIntegration } from '../src/services/accountEmailConfiguration';
import { AccountEmailOutboxRepository } from '../src/services/accountEmailOutboxRepository';
import { SignedAccountEmailWebhookVerifier } from '../src/services/accountEmailWebhook';
import { UserRepository } from '../src/services/userRepository';

const SECRET = 'test-webhook-secret-with-32-bytes';
const NOW = new Date('2026-08-15T12:00:00.000Z');
let rootDir = '';
let dbPath = '';
let server: Server;
let baseUrl = '';

before(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'primalthrum-account-email-'));
  dbPath = join(rootDir, 'platform.sqlite');
  const db = new SqliteDatabase(dbPath);
  const user = new UserRepository(db).createUser('webhook@example.com', 'hash');
  const outbox = new AccountEmailOutboxRepository(db, () => NOW);
  outbox.enqueue({ template: 'verify_email', recipientEmail: user.email,
    payload: { userId: user.id, actionUrl: 'https://app.test/verify' } });
  const claimed = outbox.claimNext();
  assert.ok(claimed);
  outbox.markDelivered(claimed.id, { provider: 'resend', providerMessageId: 'email-provider-1' });

  server = createApp({
    dbPath,
    generatedAgentsDir: join(rootDir, 'agents'),
    documentStorageDir: join(rootDir, 'documents'),
    accountEmailWebhookVerifier: new SignedAccountEmailWebhookVerifier('resend', SECRET, () => NOW),
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

test('signed email webhooks record delivery evidence idempotently', async () => {
  const body = JSON.stringify({
    type: 'email.delivered',
    created_at: NOW.toISOString(),
    data: { email_id: 'email-provider-1', to: ['webhook@example.com'] },
  });
  const first = await webhook(body, 'event-delivered-1');
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { received: true, matched: true, duplicate: false });
  const replay = await webhook(body, 'event-delivered-1');
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { received: true, matched: true, duplicate: true });
  const alteredReplay = await webhook(JSON.stringify({
    type: 'email.bounced',
    created_at: NOW.toISOString(),
    data: { email_id: 'email-provider-1' },
  }), 'event-delivered-1');
  assert.equal(alteredReplay.status, 400);

  const db = new SqliteDatabase(dbPath);
  assert.equal(db.query<{ count: number }>(`
    SELECT COUNT(*) AS count FROM account_email_delivery_events;
  `)[0]?.count, 2);
  assert.equal(db.query<{ last_provider_status: string }>(`
    SELECT last_provider_status FROM account_email_outbox LIMIT 1;
  `)[0]?.last_provider_status, 'delivered');
  assert.throws(
    () => db.run("DELETE FROM account_email_delivery_events WHERE event_type = 'delivered';"),
    /account email delivery events are immutable/,
  );
});

test('bounce webhook updates operational status without persisting recipient payload', async () => {
  const body = JSON.stringify({
    type: 'email.bounced',
    created_at: NOW.toISOString(),
    data: { email_id: 'email-provider-1', to: ['sensitive@example.com'] },
  });
  const response = await webhook(body, 'event-bounced-1');
  assert.equal(response.status, 200);
  const db = new SqliteDatabase(dbPath);
  assert.equal(new AccountEmailOutboxRepository(db).summary().bounced, 1);
  const stored = db.query<{ provider_message_id: string }>(`
    SELECT provider_message_id FROM account_email_delivery_events
    WHERE provider_event_id = 'event-bounced-1';
  `)[0];
  assert.deepEqual(stored, { provider_message_id: 'email-provider-1' });
});

test('email webhook rejects invalid signatures and exposes bounded metrics', async () => {
  const response = await fetch(`${baseUrl}/api/webhooks/email`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'svix-id': 'invalid-event',
      'svix-timestamp': String(Math.floor(NOW.getTime() / 1000)),
      'svix-signature': 'v1,invalid',
    },
    body: JSON.stringify({ type: 'email.delivered' }),
  });
  assert.equal(response.status, 400);
  const metrics = await fetch(`${baseUrl}/metrics`).then((result) => result.text());
  assert.match(metrics, /primalthrum_account_email_events_total\{outcome="delivered"\} 1/);
  assert.match(metrics, /primalthrum_account_email_events_total\{outcome="bounced"\} 1/);
  assert.match(metrics, /primalthrum_account_email_outbox\{status="bounced"\} 1/);
  assert.match(metrics, /primalthrum_account_email_outbox\{status="dead_lettered"\} 0/);
});

test('production email configuration fails closed and supports Resend', () => {
  assert.throws(
    () => createAccountEmailIntegration({ NODE_ENV: 'production' }),
    /TRANSACTIONAL_EMAIL_PROVIDER/,
  );
  const integration = createAccountEmailIntegration({
    NODE_ENV: 'production',
    TRANSACTIONAL_EMAIL_PROVIDER: 'resend',
    TRANSACTIONAL_EMAIL_API_KEY: 're_secret',
    TRANSACTIONAL_EMAIL_FROM: 'noreply@example.com',
    TRANSACTIONAL_EMAIL_WEBHOOK_SECRET: SECRET,
  });
  assert.equal(integration.provider, 'resend');
  assert.ok(integration.sender);
  assert.ok(integration.webhookVerifier);
  assert.equal(integration.exposePreview, false);
});

function webhook(body: string, eventId: string): Promise<Response> {
  const timestamp = String(Math.floor(NOW.getTime() / 1000));
  const signature = createHmac('sha256', Buffer.from(SECRET))
    .update(`${eventId}.${timestamp}.${body}`)
    .digest('base64');
  return fetch(`${baseUrl}/api/webhooks/email`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'svix-id': eventId,
      'svix-timestamp': timestamp,
      'svix-signature': `v1,${signature}`,
    },
    body,
  });
}
