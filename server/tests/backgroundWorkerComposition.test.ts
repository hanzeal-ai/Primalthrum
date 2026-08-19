import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createApp } from '../src/app';
import { createSqliteDatabase } from '../src/db/databaseFactory';
import { AccountEmailOutboxRepository } from '../src/services/accountEmailOutboxRepository';
import { closeApp } from '../src/services/appLifecycle';
import { JobRepository } from '../src/services/jobRepository';
import { UsageRatingRepository } from '../src/services/usageRatingRepository';
import { UserRepository } from '../src/services/userRepository';

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition was not met before timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('application cleanup stops polling before another job can be claimed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'primalthrum-worker-lifecycle-'));
  const database = createSqliteDatabase(join(root, 'platform.sqlite'));
  const app = createApp({
    database,
    documentStorageDir: join(root, 'documents'),
    generatedAgentsDir: join(root, 'generated-agents'),
    jobPollIntervalMs: 25,
    logger: { log: () => undefined },
  });
  const jobs = new JobRepository(database);

  try {
    const processed = jobs.create({
      type: 'document.index',
      maxAttempts: 1,
      payload: { agentId: 404, documentId: 404 },
    });
    await waitFor(() => jobs.findById(processed.id)?.status === 'failed');

    await closeApp(app);
    const queued = jobs.create({
      type: 'document.index',
      maxAttempts: 1,
      payload: { agentId: 405, documentId: 405 },
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(jobs.findById(queued.id)?.status, 'queued');
  } finally {
    await closeApp(app);
    rmSync(root, { recursive: true, force: true });
  }
});

test('external worker owns account email and usage export outbox polling', async () => {
  const root = mkdtempSync(join(tmpdir(), 'primalthrum-outbox-worker-'));
  const database = createSqliteDatabase(join(root, 'platform.sqlite'));
  const sentEmails: number[] = [];
  const exportedUsage: number[] = [];
  let holdDeliveries = false;
  let releaseDeliveries: () => void = () => undefined;
  const deliveryGate = new Promise<void>((resolve) => {
    releaseDeliveries = resolve;
  });
  const integrations = {
    accountEmailSender: {
      async send(message: { id: number }) {
        sentEmails.push(message.id);
        if (holdDeliveries) await deliveryGate;
        return { provider: 'test', providerMessageId: `email-${message.id}` };
      },
    },
    usageMeterExporter: {
      destination: 'primary',
      async send(payload: { eventId: number }) {
        exportedUsage.push(payload.eventId);
        if (holdDeliveries) await deliveryGate;
      },
    },
  };
  const httpApp = createApp({
    ...integrations,
    database,
    documentStorageDir: join(root, 'documents'),
    generatedAgentsDir: join(root, 'generated-agents'),
    jobPollIntervalMs: 25,
    logger: { log: () => undefined },
    startBackgroundSchedulers: false,
  });
  let workerApp: ReturnType<typeof createApp> | undefined;

  try {
    const user = new UserRepository(database).createUser(
      'worker-owner@example.com',
      'password-hash',
    );
    const emails = new AccountEmailOutboxRepository(database);
    const usage = new UsageRatingRepository(database);
    usage.configurePrice({
      pricingVersionKey: '2026-08-default',
      meter: 'worker.test',
      unitSize: 1,
      creditsPerUnit: 1,
    });
    const queueEmail = (sequence: number) => emails.enqueue({
      template: 'verify_email',
      recipientEmail: user.email,
      payload: { userId: user.id, sequence },
    });
    const queueUsage = (sequence: number) => usage.rate({
      workspaceId: user.workspaceId,
      idempotencyKey: `worker-test-${sequence}`,
      meter: 'worker.test',
      quantity: 1,
      enforceBudget: false,
    });

    queueEmail(1);
    queueUsage(1);
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.deepEqual(sentEmails, []);
    assert.deepEqual(exportedUsage, []);

    await closeApp(httpApp);
    workerApp = createApp({
      ...integrations,
      database,
      documentStorageDir: join(root, 'documents'),
      generatedAgentsDir: join(root, 'generated-agents'),
      jobPollIntervalMs: 25,
      logger: { log: () => undefined },
      startBackgroundSchedulers: true,
    });
    await waitFor(() => sentEmails.length === 1 && exportedUsage.length === 1);

    queueEmail(2);
    queueUsage(2);
    await waitFor(() => sentEmails.length === 2 && exportedUsage.length === 2);

    holdDeliveries = true;
    queueEmail(3);
    queueUsage(3);
    await waitFor(() => sentEmails.length === 3 && exportedUsage.length === 3);
    let closeFinished = false;
    const closeWorker = closeApp(workerApp).then(() => {
      closeFinished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(closeFinished, false);

    queueEmail(4);
    queueUsage(4);
    releaseDeliveries();
    await closeWorker;
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(sentEmails.length, 3);
    assert.equal(exportedUsage.length, 3);
    assert.equal(emails.summary().pending, 1);
    assert.equal(Number(database.query<{ count: number }>(`
      SELECT COUNT(*) AS count FROM usage_meter_exports WHERE status = 'pending';
    `)[0]?.count ?? 0), 1);
  } finally {
    await closeApp(workerApp ?? httpApp);
    rmSync(root, { recursive: true, force: true });
  }
});
