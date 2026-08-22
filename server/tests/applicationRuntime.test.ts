import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createApplicationAppOptions,
  usesExternalWorker,
} from '../src/applicationRuntime';

test('application runtime defaults to embedded workers and accepts external mode', () => {
  assert.equal(usesExternalWorker({}), false);
  assert.equal(usesExternalWorker({ BACKGROUND_WORKER_MODE: ' embedded ' }), false);
  assert.equal(usesExternalWorker({ BACKGROUND_WORKER_MODE: 'EXTERNAL' }), true);
  assert.throws(
    () => usesExternalWorker({ BACKGROUND_WORKER_MODE: 'disabled' }),
    /BACKGROUND_WORKER_MODE/,
  );
});

test('application runtime validates the durable job polling interval', () => {
  assert.equal(createApplicationAppOptions({}).jobPollIntervalMs, undefined);
  assert.equal(
    createApplicationAppOptions({ JOB_POLL_INTERVAL_MS: '250' }).jobPollIntervalMs,
    250,
  );
  assert.throws(
    () => createApplicationAppOptions({ JOB_POLL_INTERVAL_MS: '24' }),
    /JOB_POLL_INTERVAL_MS/,
  );
  assert.throws(
    () => createApplicationAppOptions({ JOB_POLL_INTERVAL_MS: 'invalid' }),
    /JOB_POLL_INTERVAL_MS/,
  );
  assert.equal(
    createApplicationAppOptions({ JOB_LEASE_DURATION_MS: '300000' }).jobLeaseDurationMs,
    300_000,
  );
  assert.throws(
    () => createApplicationAppOptions({ JOB_LEASE_DURATION_MS: '999' }),
    /JOB_LEASE_DURATION_MS/,
  );
});

test('application runtime supports mock, disabled, and Stripe payment modes', () => {
  assert.equal(createApplicationAppOptions({}).paymentAdapter?.name, 'mock');
  assert.equal(
    createApplicationAppOptions({ PAYMENT_PROVIDER: 'disabled' }).paymentAdapter,
    undefined,
  );
  assert.throws(
    () => createApplicationAppOptions({ PAYMENT_PROVIDER: 'stripe' }),
    /STRIPE_SECRET_KEY/,
  );
  assert.equal(createApplicationAppOptions({
    PAYMENT_PROVIDER: 'stripe',
    STRIPE_SECRET_KEY: 'sk_test_example',
  }).paymentAdapter?.name, 'stripe');
});
