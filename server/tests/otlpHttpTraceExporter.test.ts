import assert from 'node:assert/strict';
import test from 'node:test';

import { type LogEntry } from '../src/services/logger';
import { OtlpHttpTraceExporter } from '../src/services/otlpHttpTraceExporter';

test('OTLP HTTP exporter flushes OpenTelemetry JSON with resource and HTTP attributes', async () => {
  const requests: Array<{ body: string; headers: Headers; url: string }> = [];
  const exporter = new OtlpHttpTraceExporter({
    endpoint: 'https://collector.example.com/v1/traces',
    serviceName: 'primalthrum-server',
    serviceVersion: '2026.8.19',
    deploymentEnvironment: 'production',
    headers: { authorization: 'Bearer test-token' },
    fetchImpl: async (input, init) => {
      requests.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: String(init?.body),
      });
      return new Response(null, { status: 200 });
    },
  });
  exporter.record(span());

  await exporter.shutdown();

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, 'https://collector.example.com/v1/traces');
  assert.equal(requests[0]?.headers.get('authorization'), 'Bearer test-token');
  assert.equal(requests[0]?.headers.get('content-type'), 'application/json');
  const payload = JSON.parse(requests[0]?.body ?? '{}') as {
    resourceSpans: Array<{
      resource: { attributes: Array<{ key: string; value: { stringValue: string } }> };
      scopeSpans: Array<{ spans: Array<Record<string, unknown>> }>;
    }>;
  };
  const resource = Object.fromEntries(payload.resourceSpans[0]?.resource.attributes.map((entry) => (
    [entry.key, entry.value.stringValue]
  )) ?? []);
  assert.deepEqual(resource, {
    'service.name': 'primalthrum-server',
    'service.version': '2026.8.19',
    'deployment.environment.name': 'production',
  });
  const exported = payload.resourceSpans[0]?.scopeSpans[0]?.spans[0] as {
    flags: number;
    name: string;
    parentSpanId: string;
    status: { code: number };
    traceId: string;
  };
  assert.equal(exported.traceId, '11111111111111111111111111111111');
  assert.equal(exported.parentSpanId, '2222222222222222');
  assert.equal(exported.flags, 1);
  assert.equal(exported.name, 'GET /api/agents/:id');
  assert.equal(exported.status.code, 1);

  exporter.record(span());
  await exporter.shutdown();
  assert.equal(requests.length, 1);
});

test('OTLP HTTP exporter reports collector failures without failing shutdown', async () => {
  const entries: LogEntry[] = [];
  const exporter = new OtlpHttpTraceExporter({
    endpoint: 'http://collector.internal/v1/traces',
    serviceName: 'primalthrum-server',
    logger: { log: (entry) => entries.push(entry) },
    fetchImpl: async () => new Response(null, { status: 503 }),
  });
  exporter.record(span());

  await exporter.shutdown();

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.code, 'OTLP_TRACE_EXPORT_FAILED');
  assert.deepEqual(entries[0]?.context, { spanCount: 1 });
});

function span() {
  return {
    traceId: '11111111111111111111111111111111',
    spanId: '3333333333333333',
    parentSpanId: '2222222222222222',
    traceFlags: '01',
    name: 'GET /api/agents/:id',
    method: 'GET',
    route: '/api/agents/:id',
    statusCode: 200,
    startTimeUnixNano: '1787144400000000000',
    endTimeUnixNano: '1787144400005000000',
  };
}
