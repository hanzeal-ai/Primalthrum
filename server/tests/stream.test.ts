import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer, type Server } from 'node:http';

import { createApp } from '../src/app';

let agentServer: Server;
let appServer: Server;
let appBaseUrl = '';

before(async () => {
  agentServer = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
      });
      res.write('event: agent.update\n');
      res.write('data: {"node":"intake","message":"accepted"}\n\n');
      res.write('event: agent.done\n');
      res.end('data: {"status":"done","agent":"TestAgent"}\n\n');
      return;
    }

    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => agentServer.listen(0, resolve));
  const agentAddress = agentServer.address();
  assert(agentAddress && typeof agentAddress === 'object');

  const app = createApp({
    agentBaseUrl: `http://127.0.0.1:${agentAddress.port}`,
  });
  appServer = app.listen(0);
  await new Promise<void>((resolve) => appServer.once('listening', resolve));
  const appAddress = appServer.address();
  assert(appAddress && typeof appAddress === 'object');
  appBaseUrl = `http://127.0.0.1:${appAddress.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => appServer.close(() => resolve()));
  await new Promise<void>((resolve) => agentServer.close(() => resolve()));
});

test('POST /api/stream proxies the agent SSE stream', async () => {
  const response = await fetch(`${appBaseUrl}/api/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      goal: 'Create a support agent',
      agent: 'TestAgent',
      tools: ['knowledge_base'],
    }),
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);

  const body = await response.text();
  assert.match(body, /event: agent\.update/);
  assert.match(body, /"node":"intake"/);
  assert.match(body, /event: agent\.done/);
  assert.match(body, /"status":"done"/);
});
