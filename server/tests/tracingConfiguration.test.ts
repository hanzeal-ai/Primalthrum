import assert from 'node:assert/strict';
import test from 'node:test';

import { OtlpHttpTraceExporter } from '../src/services/otlpHttpTraceExporter';
import { createTraceExporter } from '../src/services/tracingConfiguration';

test('trace configuration is disabled by default and honors explicit none', () => {
  assert.equal(createTraceExporter({}), undefined);
  assert.equal(createTraceExporter({
    OTEL_TRACES_EXPORTER: 'none',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.com',
  }), undefined);
});

test('trace configuration creates OTLP exporter from standard environment variables', async () => {
  const exporter = createTraceExporter({
    NODE_ENV: 'production',
    OTEL_TRACES_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.com/otel',
    OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer%20secret,x-tenant=primary',
    OTEL_EXPORTER_OTLP_TIMEOUT: '2500',
    OTEL_SERVICE_NAME: 'primalthrum-api',
    OTEL_SERVICE_VERSION: '2026.8.19',
  });
  assert.ok(exporter instanceof OtlpHttpTraceExporter);
  await exporter.shutdown();
});

test('trace configuration rejects incomplete or unsafe OTLP settings', () => {
  assert.throws(
    () => createTraceExporter({ OTEL_TRACES_EXPORTER: 'otlp' }),
    /endpoint is required/,
  );
  assert.throws(
    () => createTraceExporter({ OTEL_TRACES_EXPORTER: 'zipkin' }),
    /must be otlp or none/,
  );
  assert.throws(
    () => createTraceExporter({
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'file:///tmp/traces',
    }),
    /must use http or https/,
  );
  assert.throws(
    () => createTraceExporter({
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://collector.example.com/v1/traces',
      OTEL_EXPORTER_OTLP_HEADERS: 'content-type=text/plain',
    }),
    /cannot set content-type/,
  );
  assert.throws(
    () => createTraceExporter({
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://collector.example.com/v1/traces',
      OTEL_EXPORTER_OTLP_TIMEOUT: '20',
    }),
    /OTEL_EXPORTER_OTLP_TIMEOUT/,
  );
});
