import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createServer, type Server } from 'node:http';

import { createApp } from '../src/app';
import { SqliteDatabase, sqlValue } from '../src/db/sqlite';
import { bootstrapAdminSession } from './authTestHelpers';

let agentServer: Server;
let appServer: Server;
let appBaseUrl = '';
let rootDir = '';
let authHeaders: Record<string, string> = {};
const upstreamPayloads: unknown[] = [];

before(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'primalthrum-stream-'));
  agentServer = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/stream') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        upstreamPayloads.push(JSON.parse(body));
      });
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
      });
      res.write('event: agent.run.started\n');
      res.write('data: {"node":"run","message":"started","status":"running"}\n\n');
      res.write('event: agent.node.completed\n');
      res.write('data: {"node":"intake","message":"accepted"}\n\n');
      res.write('event: agent.tool.called\n');
      res.write('data: {"node":"act_with_tools","tool":"file_reader","status":"allowed","dangerous":false,"message":"file_reader executed"}\n\n');
      res.write('event: message.completed\n');
      res.write('data: {"node":"respond","message":"Saved assistant response","sources":[{"title":"guide.md"}],"status":"done"}\n\n');
      res.write('event: agent.run.completed\n');
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
    dbPath: join(rootDir, 'platform.sqlite'),
    generatedAgentsDir: join(rootDir, 'generated-agents'),
  });
  appServer = app.listen(0);
  await new Promise<void>((resolve) => appServer.once('listening', resolve));
  const appAddress = appServer.address();
  assert(appAddress && typeof appAddress === 'object');
  appBaseUrl = `http://127.0.0.1:${appAddress.port}`;
  authHeaders = await bootstrapAdminSession(appBaseUrl, 'stream-admin@example.com');
});

after(async () => {
  await new Promise<void>((resolve) => appServer.close(() => resolve()));
  await new Promise<void>((resolve) => agentServer.close(() => resolve()));
  rmSync(rootDir, { recursive: true, force: true });
});

function jsonAuthHeaders(): Record<string, string> {
  return {
    ...authHeaders,
    'content-type': 'application/json',
  };
}

test('POST /api/stream proxies the agent SSE stream', async () => {
  const response = await fetch(`${appBaseUrl}/api/stream`, {
    method: 'POST',
    headers: jsonAuthHeaders(),
    body: JSON.stringify({
      goal: 'Create a support agent',
      agent: 'TestAgent',
      tools: ['knowledge_base'],
    }),
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);

  const body = await response.text();
  assert.match(body, /event: agent\.run\.started/);
  assert.match(body, /event: agent\.node\.completed/);
  assert.match(body, /"node":"intake"/);
  assert.match(body, /event: agent\.run\.completed/);
  assert.match(body, /"status":"done"/);
});

test('POST /api/stream can run by agentId and persist proxied events', async () => {
  upstreamPayloads.length = 0;
  const providerResponse = await fetch(`${appBaseUrl}/api/provider-configs`, {
    method: 'POST',
    headers: jsonAuthHeaders(),
    body: JSON.stringify({
      name: 'test-openai-compatible',
      type: 'llm',
      config: {
        provider: 'openai-compatible',
        model: 'gpt-test',
        baseUrl: 'https://models.example/v1',
        temperature: 0.2,
        maxTokens: 512,
      },
      secret: 'internal-test-secret',
    }),
  });
  assert.equal(providerResponse.status, 201);
  const provider = await providerResponse.json() as {
    id: number;
    secretRef: string;
  };
  assert.match(provider.secretRef, /^secret:\/\/local\//);
  assert.doesNotMatch(JSON.stringify(provider), /internal-test-secret/);

  const agentResponse = await fetch(`${appBaseUrl}/api/agents`, {
    method: 'POST',
    headers: jsonAuthHeaders(),
    body: JSON.stringify({
      name: 'Configured Stream Agent',
      description: 'Uses stored config',
      memoryProvider: 'sqlite',
      cacheProvider: 'memory',
      ragProvider: 'in-memory',
      enabledTools: ['file_reader'],
      enabledSkills: ['research'],
      modelConfig: {
        default: {
          provider: 'openai-compatible',
          providerConfigId: provider.id,
          model: 'gpt-test',
        },
        embedding: { provider: 'mock', model: 'mock-embedding' },
      },
    }),
  });
  assert.equal(agentResponse.status, 201);
  const agent = await agentResponse.json() as { id: number; slug: string };

  const versionResponse = await fetch(`${appBaseUrl}/api/agents/${agent.id}/versions`, {
    method: 'POST',
    headers: authHeaders,
  });
  assert.equal(versionResponse.status, 201);
  const preview = await versionResponse.json() as { version: { id: number } };

  const response = await fetch(`${appBaseUrl}/api/stream`, {
    method: 'POST',
    headers: jsonAuthHeaders(),
    body: JSON.stringify({
      agentId: agent.id,
      versionId: preview.version.id,
      input: 'Use the saved agent config',
    }),
  });

  assert.equal(response.status, 200);
  const runId = Number(response.headers.get('x-primalthrum-run-id'));
  const conversationId = Number(response.headers.get('x-primalthrum-conversation-id'));
  assert.ok(runId > 0);
  assert.ok(conversationId > 0);
  const body = await response.text();
  assert.match(body, /event: agent\.node\.completed/);
  assert.equal(upstreamPayloads.length, 1);
  assert.deepEqual(upstreamPayloads[0], {
    goal: 'Use the saved agent config',
    agent: 'Configured Stream Agent',
    tools: ['file_reader'],
    skills: ['research'],
    memory_provider: 'sqlite',
    cache_provider: 'memory',
    rag_provider: 'in-memory',
    llm: {
      provider: 'openai-compatible',
      model: 'gpt-test',
      api_key: 'internal-test-secret',
      base_url: 'https://models.example/v1',
      temperature: 0.2,
      max_tokens: 512,
    },
    embedding: {
      provider: 'mock',
      model: 'mock-embedding',
    },
  });

  const runResponse = await fetch(`${appBaseUrl}/api/runs/${runId}`, {
    headers: authHeaders,
  });
  assert.equal(runResponse.status, 200);
  const run = await runResponse.json() as {
    agentId: number;
    agentVersionId: number | null;
    input: string;
  };
  assert.equal(run.agentId, agent.id);
  assert.equal(run.agentVersionId, preview.version.id);
  assert.equal(run.input, 'Use the saved agent config');

  const eventsResponse = await fetch(`${appBaseUrl}/api/runs/${runId}/events`, {
    headers: authHeaders,
  });
  assert.equal(eventsResponse.status, 200);
  const events = await eventsResponse.json() as Array<{
    eventType: string;
    node: string;
    payload: Record<string, unknown>;
  }>;
  assert.deepEqual(events.map((event) => event.eventType), [
    'agent.run.started',
    'agent.node.completed',
    'agent.tool.called',
    'message.completed',
    'agent.run.completed',
  ]);
  assert.equal(events[0]?.node, 'run');
  assert.equal(events[1]?.node, 'intake');
  assert.equal(events[2]?.node, 'act_with_tools');
  assert.equal(events[3]?.payload.message, 'Saved assistant response');
  assert.equal(events[4]?.payload.status, 'done');

  const conversationsResponse = await fetch(
    `${appBaseUrl}/api/agents/${agent.id}/conversations`,
    { headers: authHeaders },
  );
  assert.equal(conversationsResponse.status, 200);
  const conversations = await conversationsResponse.json() as Array<{ id: number }>;
  assert.equal(conversations[0]?.id, conversationId);

  const messagesResponse = await fetch(
    `${appBaseUrl}/api/conversations/${conversationId}/messages`,
    { headers: authHeaders },
  );
  assert.equal(messagesResponse.status, 200);
  const messages = await messagesResponse.json() as Array<{
    role: string;
    content: string;
    sources: Array<{ title: string }>;
  }>;
  assert.deepEqual(messages.map((message) => ({
    role: message.role,
    content: message.content,
    sources: message.sources,
  })), [
    { role: 'user', content: 'Use the saved agent config', sources: [] },
    {
      role: 'assistant',
      content: 'Saved assistant response',
      sources: [{ title: 'guide.md' }],
    },
  ]);

  const auditResponse = await fetch(`${appBaseUrl}/api/audit/tool-calls?runId=${runId}`, {
    headers: authHeaders,
  });
  assert.equal(auditResponse.status, 200);
  const auditRecords = await auditResponse.json() as Array<{
    runId: number;
    toolName: string;
    status: string;
    dangerous: boolean;
  }>;
  assert.deepEqual(auditRecords.map((record) => ({
    runId: record.runId,
    toolName: record.toolName,
    status: record.status,
    dangerous: record.dangerous,
  })), [
    {
      runId,
      toolName: 'file_reader',
      status: 'allowed',
      dangerous: false,
    },
  ]);

  const db = new SqliteDatabase(join(rootDir, 'platform.sqlite'));
  db.run(`UPDATE agents SET status = 'generated' WHERE id = ${sqlValue(agent.id)};`);
  const publishResponse = await fetch(`${appBaseUrl}/api/agents/${agent.id}/audience`, {
    method: 'PUT',
    headers: jsonAuthHeaders(),
    body: JSON.stringify({ audience: 'public' }),
  });
  assert.equal(publishResponse.status, 200);

  const publicStreamResponse = await fetch(
    `${appBaseUrl}/api/public/agents/${agent.slug}/stream`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'Run without an authenticated session' }),
    },
  );
  assert.equal(publicStreamResponse.status, 200);
  assert.match(await publicStreamResponse.text(), /event: message\.completed/);
  assert.equal(upstreamPayloads.length, 2);
});
