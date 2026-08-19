import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAsyncSqliteDatabase } from '../src/db/asyncDatabaseFactory';
import { type AsyncSqliteDatabase } from '../src/db/asyncSqlite';
import { AsyncAccountEmailOutboxRepository } from '../src/services/asyncAccountEmailOutboxRepository';
import { AsyncAccountOnboardingRepository } from '../src/services/asyncAccountOnboardingRepository';
import { AsyncAccountTokenRepository } from '../src/services/asyncAccountTokenRepository';
import { AccountEmailDispatcher } from '../src/services/accountEmailDispatcher';
import { AccountEmailDeliveryError } from '../src/services/accountEmailSender';
import { AsyncUserRepository } from '../src/services/asyncUserRepository';
import { AsyncWorkspaceRepository } from '../src/services/asyncWorkspaceRepository';

const NOW = new Date(Date.now() + 60_000);
const logger = { log: () => undefined };

function createDatabase(): { database: AsyncSqliteDatabase; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'primalthrum-async-account-lifecycle-'));
  return {
    database: createAsyncSqliteDatabase(join(root, 'database.sqlite')),
    root,
  };
}

test('async account tokens and onboarding preserve one-time lifecycle semantics', async () => {
  const { database, root } = createDatabase();
  let now = NOW;
  const users = new AsyncUserRepository(database);
  const workspaces = new AsyncWorkspaceRepository(database);
  const tokens = new AsyncAccountTokenRepository(database, () => now);
  const onboarding = new AsyncAccountOnboardingRepository(database);
  try {
    const owner = await users.createUser('async-account@example.com', 'hash');
    const workspace = await workspaces.create(owner.id, 'Async Account');
    const created = await onboarding.create(workspace.id, owner.id, 'pro');
    assert.equal(created.state, 'pending_email');

    const superseded = await tokens.create({
      userId: owner.id,
      purpose: 'verify_email',
      ttlMs: 1000,
    });
    const current = await tokens.create({
      userId: owner.id,
      purpose: 'verify_email',
      ttlMs: 1000,
      payload: { source: 'resend' },
    });
    assert.equal(await tokens.consume(superseded, 'verify_email'), null);
    assert.deepEqual(await tokens.consume(current, 'verify_email'), {
      userId: owner.id,
      payload: { source: 'resend' },
    });
    assert.equal(await tokens.consume(current, 'verify_email'), null);

    const expiring = await tokens.create({
      userId: owner.id,
      purpose: 'reset_password',
      ttlMs: 1000,
    });
    now = new Date(now.getTime() + 1_001);
    assert.equal(await tokens.consume(expiring, 'reset_password'), null);
    await onboarding.activate(workspace.id, now.toISOString());
    assert.equal((await onboarding.findForUser(owner.id))?.state, 'active');
  } finally {
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('async account email outbox claims once and records provider evidence idempotently', async () => {
  const { database, root } = createDatabase();
  const users = new AsyncUserRepository(database);
  const outbox = new AsyncAccountEmailOutboxRepository(database, () => NOW);
  try {
    const user = await users.createUser('async-email@example.com', 'hash');
    await outbox.enqueue({
      template: 'verify_email',
      recipientEmail: user.email,
      payload: { userId: user.id, actionUrl: 'https://app.test/verify' },
    });
    let deliveryCount = 0;
    const sender = {
      send: async () => {
        deliveryCount += 1;
        return { provider: 'test', providerMessageId: 'async-message-1' };
      },
    };
    await Promise.all([
      new AccountEmailDispatcher(outbox, sender, logger).drain(),
      new AccountEmailDispatcher(outbox, sender, logger).drain(),
    ]);
    assert.equal(deliveryCount, 1);
    assert.equal((await outbox.summary()).delivered, 1);

    const event = {
      provider: 'test',
      providerEventId: 'delivered:async-message-1',
      providerMessageId: 'async-message-1',
      eventType: 'delivered' as const,
      occurredAt: NOW.toISOString(),
    };
    assert.deepEqual(await outbox.recordProviderEvent(event), {
      duplicate: false,
      matched: true,
      outboxId: 1,
    });
    assert.equal((await outbox.recordProviderEvent(event)).duplicate, true);
    await assert.rejects(
      outbox.recordProviderEvent({ ...event, eventType: 'bounced' }),
      /idempotency conflict/,
    );
  } finally {
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('async account email outbox dead-letters permanent failures', async () => {
  const { database, root } = createDatabase();
  const users = new AsyncUserRepository(database);
  const outbox = new AsyncAccountEmailOutboxRepository(database, () => NOW);
  try {
    const user = await users.createUser('async-dead-letter@example.com', 'hash');
    await outbox.enqueue({
      template: 'reset_password',
      recipientEmail: user.email,
      payload: { userId: user.id, actionUrl: 'https://app.test/reset' },
    });
    await new AccountEmailDispatcher(outbox, {
      send: async () => {
        throw new AccountEmailDeliveryError('invalid recipient', false);
      },
    }, logger).drain();
    assert.equal(await outbox.claimNext(), null);
    assert.equal((await outbox.summary()).deadLettered, 1);
    const rows = await database.query<{ payload_json: string }>({
      text: 'SELECT payload_json FROM account_email_outbox;',
    });
    assert.equal(rows[0]?.payload_json, '{}');
  } finally {
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
