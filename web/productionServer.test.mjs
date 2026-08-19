import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createProductionServer } from './productionServer.mjs';

test('production server serves SPA assets with security and cache headers', async () => {
  const root = await createWebRoot();
  const server = createProductionServer({ distDir: root, logger: silentLogger });
  const origin = await listen(server);
  try {
    const health = await fetch(`${origin}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok', service: 'web' });

    const route = await fetch(`${origin}/agents/42`);
    assert.equal(route.status, 200);
    assert.equal(await route.text(), '<html>Primalthrum</html>');
    assert.match(route.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    assert.equal(route.headers.get('cache-control'), 'no-cache');

    const asset = await fetch(`${origin}/assets/app-deadbeef.js`);
    assert.equal(await asset.text(), 'console.log("ready")');
    assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');

    const missing = await fetch(`${origin}/missing.js`);
    assert.equal(missing.status, 404);
  } finally {
    await close(server);
    await rm(root, { recursive: true, force: true });
  }
});

test('production server proxies API methods, bodies, and forwarding headers', async () => {
  const root = await createWebRoot();
  let received;
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = {
      method: request.method,
      url: request.url,
      body: Buffer.concat(chunks).toString('utf8'),
      forwardedHost: request.headers['x-forwarded-host'],
      forwardedFor: request.headers['x-forwarded-for'],
    };
    response.writeHead(202, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ accepted: true }));
  });
  const upstreamOrigin = await listen(upstream);
  const server = createProductionServer({
    distDir: root,
    proxyTarget: upstreamOrigin,
    logger: silentLogger,
  });
  const origin = await listen(server);
  try {
    const response = await fetch(`${origin}/api/runs?stream=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: 'ship' }),
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { accepted: true });
    assert.equal(received.method, 'POST');
    assert.equal(received.url, '/api/runs?stream=1');
    assert.equal(received.body, '{"goal":"ship"}');
    assert.match(String(received.forwardedHost), /127\.0\.0\.1/);
    assert.ok(received.forwardedFor);
  } finally {
    await close(server);
    await close(upstream);
    await rm(root, { recursive: true, force: true });
  }
});

test('production server rejects unsafe configuration and encoded traversal', async () => {
  assert.throws(
    () => createProductionServer({ proxyTarget: 'file:///tmp/server' }),
    /must use http or https/,
  );
  assert.throws(
    () => createProductionServer({ forwardedProto: 'ftp' }),
    /FORWARDED_PROTO must be http or https/,
  );
  assert.throws(
    () => createProductionServer({ proxyTarget: 'https://user:secret@example.com' }),
    /must not contain credentials/,
  );
  const root = await createWebRoot();
  const server = createProductionServer({ distDir: root, logger: silentLogger });
  const origin = await listen(server);
  try {
    const response = await fetch(`${origin}/..%2Fsecret.txt`);
    assert.equal(response.status, 400);
    assert.equal(await rawStatus(origin, '//attacker.invalid/api/runs'), 400);
  } finally {
    await close(server);
    await rm(root, { recursive: true, force: true });
  }
});

const silentLogger = { error: () => undefined };

async function createWebRoot() {
  const root = await mkdtemp(join(tmpdir(), 'primalthrum-web-production-'));
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), '<html>Primalthrum</html>');
  await writeFile(join(root, 'assets', 'app-deadbeef.js'), 'console.log("ready")');
  return root;
}

function listen(server) {
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert(address && typeof address === 'object');
      resolvePromise(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => error ? reject(error) : resolvePromise());
  });
}

function rawStatus(origin, path) {
  const target = new URL(origin);
  return new Promise((resolvePromise, reject) => {
    const clientRequest = request({
      host: target.hostname,
      port: target.port,
      path,
    }, (response) => {
      response.resume();
      response.once('end', () => resolvePromise(response.statusCode));
    });
    clientRequest.once('error', reject);
    clientRequest.end();
  });
}
