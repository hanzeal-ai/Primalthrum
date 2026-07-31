import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { createApp } from '../src/app';
import { SqliteDatabase } from '../src/db/sqlite';

const SUBJECT_ID = '11111111-1111-4111-8111-111111111111';
const EVENT_ID = '22222222-2222-4222-8222-222222222222';
const TEST_OCCURRED_AT = new Date().toISOString();
let rootDir = '';
let dbPath = '';
let server: Server;
let baseUrl = '';

before(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'primalthrum-privacy-'));
  dbPath = join(rootDir, 'platform.sqlite');
  server = createApp({
    dbPath,
    documentStorageDir: join(rootDir, 'documents'),
    generatedAgentsDir: join(rootDir, 'generated-agents'),
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

test('privacy config defaults analytics to disabled', async () => {
  const response = await fetch(`${baseUrl}/api/public/privacy/config`);
  assert.equal(response.status, 200);
  const config = await response.json() as {
    policyVersion: string;
    categories: { necessary: { required: boolean }; analytics: { default: boolean } };
  };
  assert.equal(config.policyVersion, '2026-07-31');
  assert.equal(config.categories.necessary.required, true);
  assert.equal(config.categories.analytics.default, false);
});

test('analytics requires the latest explicit grant and supports withdrawal', async () => {
  const denied = await consent(false, 'banner');
  assert.equal(denied.action, 'denied');
  assert.equal(denied.analytics, false);

  const deniedEvent = await analyticsEvent(denied.receiptId, EVENT_ID);
  assert.equal(deniedEvent.status, 403);
  assert.equal((await deniedEvent.json() as { error: { code: string } }).error.code,
    'ANALYTICS_CONSENT_REQUIRED');

  const granted = await consent(true, 'preferences');
  assert.equal(granted.action, 'granted');
  const accepted = await analyticsEvent(granted.receiptId, EVENT_ID);
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), { accepted: true, eventId: EVENT_ID, duplicate: false });

  const replay = await analyticsEvent(granted.receiptId, EVENT_ID);
  assert.equal(replay.status, 202);
  assert.equal((await replay.json() as { duplicate: boolean }).duplicate, true);

  const conflict = await analyticsEvent(granted.receiptId, EVENT_ID, '/pricing');
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json() as { error: { code: string } }).error.code,
    'ANALYTICS_EVENT_INVALID');

  const withdrawn = await consent(false, 'preferences');
  assert.equal(withdrawn.action, 'withdrawn');
  const replayAfterWithdrawal = await analyticsEvent(granted.receiptId, EVENT_ID);
  assert.equal(replayAfterWithdrawal.status, 403);
  const staleGrant = await analyticsEvent(
    granted.receiptId,
    '33333333-3333-4333-8333-333333333333',
  );
  assert.equal(staleGrant.status, 403);
});

test('analytics rejects sensitive or unbounded properties', async () => {
  const granted = await consent(true, 'banner');
  const response = await fetch(`${baseUrl}/api/public/analytics/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      subjectId: SUBJECT_ID,
      consentReceiptId: granted.receiptId,
      eventId: '44444444-4444-4444-8444-444444444444',
      eventName: 'signup_submitted',
      path: '/signup',
      properties: { email: 'owner@example.com' },
      occurredAt: new Date().toISOString(),
    }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json() as { error: { code: string } }).error.code,
    'ANALYTICS_EVENT_INVALID');
});

test('privacy and analytics evidence is immutable', () => {
  const db = new SqliteDatabase(dbPath);
  assert.equal(db.query<{ count: number }>('SELECT COUNT(*) AS count FROM privacy_consent_receipts;')[0]?.count, 4);
  assert.equal(db.query<{ count: number }>('SELECT COUNT(*) AS count FROM product_analytics_events;')[0]?.count, 1);
  assert.throws(
    () => db.run('UPDATE privacy_consent_receipts SET analytics_granted = 0 WHERE id = 1;'),
    /privacy consent receipts are immutable/,
  );
  assert.throws(
    () => db.run('DELETE FROM product_analytics_events WHERE id = 1;'),
    /product analytics events are immutable/,
  );
});

async function consent(analytics: boolean, source: 'banner' | 'preferences') {
  const response = await fetch(`${baseUrl}/api/public/privacy/consents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      subjectId: SUBJECT_ID,
      policyVersion: '2026-07-31',
      analytics,
      source,
    }),
  });
  assert.equal(response.status, 201);
  return response.json() as Promise<{
    receiptId: string;
    analytics: boolean;
    action: 'granted' | 'denied' | 'withdrawn';
  }>;
}

function analyticsEvent(receiptId: string, eventId: string, path = '/') {
  return fetch(`${baseUrl}/api/public/analytics/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      subjectId: SUBJECT_ID,
      consentReceiptId: receiptId,
      eventId,
      eventName: 'page_view',
      path,
      properties: { source: 'direct', authenticated: false },
      occurredAt: TEST_OCCURRED_AT,
    }),
  });
}
