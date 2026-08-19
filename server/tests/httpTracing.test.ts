import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createApp } from '../src/app';
import { closeApp } from '../src/services/appLifecycle';
import { type HttpServerTraceSpan, type HttpTraceExporter } from '../src/services/httpTraceExporter';

test('application HTTP tracing continues W3C context and flushes sampled spans', async () => {
  const root = mkdtempSync(join(tmpdir(), 'primalthrum-http-tracing-'));
  const exporter = new CapturingTraceExporter();
  const app = createApp({
    dbPath: join(root, 'platform.sqlite'),
    documentStorageDir: join(root, 'documents'),
    generatedAgentsDir: join(root, 'agents'),
    logger: { log: () => undefined },
    startBackgroundSchedulers: false,
    traceExporter: exporter,
  });
  const server = app.listen(0, '127.0.0.1');
  const origin = await listeningOrigin(server);
  const parentTraceId = '11111111111111111111111111111111';
  const parentSpanId = '2222222222222222';

  try {
    const response = await fetch(`${origin}/health`, {
      headers: { traceparent: `00-${parentTraceId}-${parentSpanId}-01` },
    });
    assert.equal(response.status, 200);
    const responseTraceparent = response.headers.get('traceparent') ?? '';
    assert.match(responseTraceparent, new RegExp(`^00-${parentTraceId}-[0-9a-f]{16}-01$`));
    assert.equal(response.headers.get('x-request-id'), parentTraceId);
    assert.match(response.headers.get('access-control-expose-headers') ?? '', /Traceparent/);
    assert.equal(exporter.spans.length, 1);
    assert.equal(exporter.spans[0]?.traceId, parentTraceId);
    assert.equal(exporter.spans[0]?.parentSpanId, parentSpanId);
    assert.equal(exporter.spans[0]?.name, 'GET /health');
    assert.equal(exporter.spans[0]?.statusCode, 200);

    const unmatched = await fetch(`${origin}/private-customer-slug`);
    assert.equal(unmatched.status, 401);
    assert.equal(exporter.spans[1]?.route, 'unmatched');
    assert.equal(JSON.stringify(exporter.spans[1]).includes('private-customer-slug'), false);

    const unsampled = await fetch(`${origin}/health`, {
      headers: { traceparent: `00-${parentTraceId}-${parentSpanId}-00` },
    });
    assert.equal(unsampled.status, 200);
    assert.equal(exporter.spans.length, 2);
  } finally {
    await closeServer(server);
    await closeApp(app);
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(exporter.shutdownCalls, 1);
});

class CapturingTraceExporter implements HttpTraceExporter {
  readonly spans: HttpServerTraceSpan[] = [];
  shutdownCalls = 0;

  record(span: HttpServerTraceSpan): void {
    this.spans.push(span);
  }

  async shutdown(): Promise<void> {
    this.shutdownCalls += 1;
  }
}

function listeningOrigin(server: Server): Promise<string> {
  return new Promise((resolve) => {
    const ready = () => {
      const address = server.address();
      assert(address && typeof address === 'object');
      resolve(`http://127.0.0.1:${address.port}`);
    };
    if (server.listening) ready();
    else server.once('listening', ready);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
