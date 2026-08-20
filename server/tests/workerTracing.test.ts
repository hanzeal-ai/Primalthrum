import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createSqliteDatabase } from '../src/db/databaseFactory';
import { AccountEmailDispatcher } from '../src/services/accountEmailDispatcher';
import { AccountEmailOutboxRepository } from '../src/services/accountEmailOutboxRepository';
import { DurableJobDispatcher } from '../src/services/durableJobDispatcher';
import { JobRepository } from '../src/services/jobRepository';
import { OtlpHttpTraceExporter } from '../src/services/otlpHttpTraceExporter';
import { UsageExportDispatcher } from '../src/services/usageExportDispatcher';
import { UsageExportOutboxRepository } from '../src/services/usageExportOutboxRepository';
import { UsageRatingRepository } from '../src/services/usageRatingRepository';
import { UserRepository } from '../src/services/userRepository';
import { type WorkerTraceExporter, type WorkerTraceSpan } from '../src/services/workerTraceExporter';
import { traceWorkerOperation } from '../src/services/workerTracing';

const logger = { log: () => undefined };

test('Worker tracing records outcomes and exporter failures never change delivery', async () => {
  const spans: WorkerTraceSpan[] = [];
  const exporter: WorkerTraceExporter = { record: (span) => { spans.push(span); } };
  const input = {
    queue: 'durable_job' as const,
    operation: 'document.index',
    messageId: '42',
    attempt: 1,
  };

  assert.equal(await traceWorkerOperation(exporter, input, () => 'done'), 'done');
  await assert.rejects(
    traceWorkerOperation(exporter, input, () => { throw new TypeError('private detail'); }),
    /private detail/,
  );
  assert.deepEqual(spans.map((span) => span.outcome), ['succeeded', 'failed']);
  assert.equal(spans[1]?.errorType, 'TypeError');
  assert.equal(JSON.stringify(spans).includes('private detail'), false);

  const result = await traceWorkerOperation(
    { record: () => { throw new Error('collector unavailable'); } },
    input,
    () => 'still-delivered',
  );
  assert.equal(result, 'still-delivered');
});

test('Durable Job dispatcher emits one privacy-minimized Worker Span', async () => {
  await withDatabase(async (db) => {
    const jobs = new JobRepository(db);
    const queued = jobs.create({
      type: 'document.index',
      payload: { privateText: 'do-not-export' },
    });
    const traces = new CapturingWorkerTraceExporter();
    const dispatcher = new DurableJobDispatcher(
      jobs,
      { 'document.index': () => ({ indexed: true }) },
      () => undefined,
      30_000,
      traces,
    );

    dispatcher.start(25);
    try {
      await waitFor(() => jobs.findById(queued.id)?.status === 'succeeded');
    } finally {
      await dispatcher.stop();
    }

    assertWorkerSpan(traces.spans[0], 'durable_job', 'document.index', queued.id);
    assert.equal(JSON.stringify(traces.spans).includes('do-not-export'), false);
  });
});

test('email and usage Outbox dispatchers emit queue-specific Worker Spans', async () => {
  await withDatabase(async (db) => {
    const traces = new CapturingWorkerTraceExporter();
    const user = new UserRepository(db).createUser('private@example.com', 'hash');
    const emailOutbox = new AccountEmailOutboxRepository(db);
    emailOutbox.enqueue({
      template: 'verify_email',
      recipientEmail: user.email,
      payload: { userId: user.id, actionUrl: 'https://private.example/verify' },
    });
    await new AccountEmailDispatcher(emailOutbox, {
      send: async () => ({ provider: 'test', providerMessageId: 'provider-message' }),
    }, logger, 25, traces).drain();

    const usageOutbox = new UsageExportOutboxRepository(db);
    new UsageRatingRepository(db).rate({
      workspaceId: 1,
      idempotencyKey: 'private-idempotency-key',
      meter: 'llm.output_tokens',
      quantity: 5,
    });
    await new UsageExportDispatcher(usageOutbox, {
      destination: 'primary',
      send: async () => undefined,
    }, logger, 50, traces).drain();

    assertWorkerSpan(traces.spans[0], 'account_email_outbox', 'verify_email', 1);
    assertWorkerSpan(traces.spans[1], 'usage_export_outbox', 'llm.output_tokens', 1);
    const serialized = JSON.stringify(traces.spans);
    assert.equal(serialized.includes('private@example.com'), false);
    assert.equal(serialized.includes('private-idempotency-key'), false);
    assert.equal(serialized.includes('primary'), false);
  });
});

test('OTLP exporter writes Worker Consumer Spans in a separate scope', async () => {
  let payload: Record<string, unknown> | undefined;
  const exporter = new OtlpHttpTraceExporter({
    endpoint: 'https://collector.example/v1/traces',
    serviceName: 'primalthrum-worker',
    fetchImpl: async (_input, init) => {
      payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(null, { status: 200 });
    },
  });
  await traceWorkerOperation(exporter, {
    queue: 'durable_job', operation: 'retention.enforce', messageId: '7', attempt: 2,
  }, () => undefined);
  await exporter.shutdown();

  const resourceSpans = payload?.resourceSpans as Array<Record<string, unknown>>;
  const scopes = resourceSpans[0]?.scopeSpans as Array<Record<string, unknown>>;
  assert.deepEqual(scopes[0]?.scope, { name: 'primalthrum.worker' });
  const spans = scopes[0]?.spans as Array<Record<string, unknown>>;
  assert.equal(spans[0]?.kind, 4);
  assert.equal(spans[0]?.name, 'durable_job retention.enforce');
  assert.equal((spans[0]?.status as { code: number }).code, 1);
  assert.match(JSON.stringify(spans[0]?.attributes), /messaging\.message\.receive_count/);
});

class CapturingWorkerTraceExporter implements WorkerTraceExporter {
  readonly spans: WorkerTraceSpan[] = [];

  record(span: WorkerTraceSpan): void {
    this.spans.push(span);
  }
}

function assertWorkerSpan(
  span: WorkerTraceSpan | undefined,
  queue: WorkerTraceSpan['queue'],
  operation: string,
  messageId: number,
): void {
  assert(span);
  assert.equal(span.queue, queue);
  assert.equal(span.operation, operation);
  assert.equal(span.messageId, String(messageId));
  assert.equal(span.attempt, 1);
  assert.equal(span.outcome, 'succeeded');
  assert.match(span.traceId, /^[0-9a-f]{32}$/);
  assert.match(span.spanId, /^[0-9a-f]{16}$/);
}

async function withDatabase(operation: (db: ReturnType<typeof createSqliteDatabase>) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'primalthrum-worker-tracing-'));
  try {
    await operation(createSqliteDatabase(join(root, 'platform.sqlite')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition was not met before timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
