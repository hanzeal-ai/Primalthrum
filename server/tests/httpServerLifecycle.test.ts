import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import Koa from 'koa';

import { registerAppCleanup } from '../src/services/appLifecycle';
import { HttpServerLifecycle } from '../src/services/httpServerLifecycle';

test('HTTP lifecycle drains an active response before App and database cleanup', async () => {
  const events: string[] = [];
  const requestStarted = deferred<void>();
  const releaseResponse = deferred<void>();
  const app = new Koa();
  registerAppCleanup(app, () => { events.push('app-cleanup'); });
  const database = {
    async close() { events.push('database-close'); },
  };
  const server = createServer(async (_request, response) => {
    response.writeHead(200, {
      connection: 'close',
      'content-type': 'text/plain; charset=utf-8',
    });
    response.write('first\n');
    events.push('request-started');
    requestStarted.resolve();
    await releaseResponse.promise;
    response.end('last\n');
    events.push('request-ended');
  });
  const origin = await listen(server);
  const lifecycle = new HttpServerLifecycle({
    app,
    database,
    logger: silentLogger,
    onTimeout: () => undefined,
    server,
    shutdownTimeoutMs: 2_000,
  });

  try {
    const responsePromise = fetch(origin, { headers: { connection: 'close' } });
    await requestStarted.promise;
    const firstShutdown = lifecycle.shutdown('SIGTERM');
    const secondShutdown = lifecycle.shutdown('SIGINT');
    assert.equal(firstShutdown, secondShutdown);
    let shutdownFinished = false;
    void firstShutdown.then(() => { shutdownFinished = true; });
    await delay(25);
    assert.equal(shutdownFinished, false);
    assert.deepEqual(events, ['request-started']);
    await assert.rejects(fetch(origin));

    releaseResponse.resolve();
    const response = await responsePromise;
    assert.equal(await response.text(), 'first\nlast\n');
    await firstShutdown;
    assert.deepEqual(events, [
      'request-started',
      'request-ended',
      'app-cleanup',
      'database-close',
    ]);
  } finally {
    releaseResponse.resolve();
    if (server.listening) await close(server);
  }
});

test('HTTP lifecycle closes the database after an App cleanup failure', async () => {
  const app = new Koa();
  const cleanupError = new Error('cleanup failed');
  registerAppCleanup(app, () => { throw cleanupError; });
  let databaseClosed = false;
  const server = createServer((_request, response) => response.end('ok'));
  await listen(server);
  const lifecycle = new HttpServerLifecycle({
    app,
    database: { async close() { databaseClosed = true; } },
    logger: silentLogger,
    onTimeout: () => undefined,
    server,
  });

  await assert.rejects(lifecycle.shutdown('SIGTERM'), cleanupError);
  assert.equal(databaseClosed, true);
});

const silentLogger = { error: () => undefined, log: () => undefined };

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert(address && typeof address === 'object');
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
