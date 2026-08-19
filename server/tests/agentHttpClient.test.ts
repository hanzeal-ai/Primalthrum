import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';

import Koa from 'koa';

import { fetchAgent } from '../src/services/agentHttpClient';
import { createHttpTracingMiddleware } from '../src/services/httpTracingMiddleware';
import { type HttpTraceExporter } from '../src/services/httpTraceExporter';

interface CapturedRequest {
  path: string;
  traceparent?: string;
}

test('trusted Agent requests propagate isolated W3C context without affecting external fetch', async () => {
  const captured: CapturedRequest[] = [];
  const upstream = createServer((request, response) => {
    captured.push({
      path: request.url ?? '',
      ...(typeof request.headers.traceparent === 'string'
        ? { traceparent: request.headers.traceparent }
        : {}),
    });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  });
  const upstreamOrigin = await listen(upstream);
  const exporter: HttpTraceExporter = { record: () => undefined, shutdown: async () => undefined };
  const app = new Koa();
  app.use(createHttpTracingMiddleware(exporter));
  app.use(async (ctx) => {
    await Promise.all([
      fetchAgent(upstreamOrigin, `/agent?request=${ctx.query.request}`),
      fetch(`${upstreamOrigin}/external?request=${ctx.query.request}`),
    ]);
    ctx.body = { ok: true };
  });
  const appServer = app.listen(0, '127.0.0.1');
  const appOrigin = await listeningOrigin(appServer);
  const firstTraceId = '11111111111111111111111111111111';
  const secondTraceId = '33333333333333333333333333333333';

  try {
    const [first, second] = await Promise.all([
      fetch(`${appOrigin}/?request=first`, {
        headers: { traceparent: `00-${firstTraceId}-2222222222222222-01` },
      }),
      fetch(`${appOrigin}/?request=second`, {
        headers: { traceparent: `00-${secondTraceId}-4444444444444444-01` },
      }),
    ]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);

    const byPath = new Map(captured.map((request) => [request.path, request]));
    assert.match(
      byPath.get('/agent?request=first')?.traceparent ?? '',
      new RegExp(`^00-${firstTraceId}-[0-9a-f]{16}-01$`),
    );
    assert.match(
      byPath.get('/agent?request=second')?.traceparent ?? '',
      new RegExp(`^00-${secondTraceId}-[0-9a-f]{16}-01$`),
    );
    assert.equal(byPath.get('/external?request=first')?.traceparent, undefined);
    assert.equal(byPath.get('/external?request=second')?.traceparent, undefined);
  } finally {
    await close(appServer);
    await close(upstream);
  }
});

test('Agent transport strips caller trace headers outside an active server request', async () => {
  let capturedTraceparent: string | undefined;
  const upstream = createServer((request, response) => {
    capturedTraceparent = typeof request.headers.traceparent === 'string'
      ? request.headers.traceparent
      : undefined;
    response.writeHead(204).end();
  });
  const upstreamOrigin = await listen(upstream);

  try {
    const response = await fetchAgent(upstreamOrigin, '/agent', {
      headers: { traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01' },
    });
    assert.equal(response.status, 204);
    assert.equal(capturedTraceparent, undefined);
    assert.throws(
      () => fetchAgent(upstreamOrigin, 'https://external.example/unsafe'),
      /absolute local path/,
    );
    assert.throws(
      () => fetchAgent(upstreamOrigin, '/\\external.example/unsafe'),
      /absolute local path/,
    );
  } finally {
    await close(upstream);
  }
});

function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  return listeningOrigin(server);
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

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
