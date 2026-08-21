import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createServer, type Server } from 'node:http';

import { createApp } from '../src/app';
import { SqliteDatabase, sqlValue } from '../src/db/sqlite';
import { createSqliteDatabase } from '../src/db/databaseFactory';
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
    if (req.method === 'GET' && req.url === '/capabilities') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        schemaVersion: '1.0',
        capabilities: [
          {
            kind: 'tool', name: 'file_reader', version: '1.0.0',
            description: 'Read approved files.', status: 'available', hotPluggable: true,
            configSchema: { type: 'object' }, permissions: ['fs:read'], dependencies: [],
          },
          {
            kind: 'memory', name: 'sqlite', version: '1.0.0',
            description: 'SQLite memory.', status: 'available', hotPluggable: true,
            configSchema: { type: 'object' }, permissions: [], dependencies: [],
          },
          {
            kind: 'stt', name: 'openai', version: '1.0.0',
            description: 'Speech to text.', status: 'planned', hotPluggable: true,
            configSchema: { type: 'object' }, permissions: [], dependencies: [],
          },
        ],
        health: [
          { key: 'tool:file_reader', status: 'ok' },
          { key: 'memory:sqlite', status: 'ok' },
          { key: 'stt:openai', status: 'planned' },
        ],
      }));
      return;
    }
    if (req.method === 'POST' && req.url === '/internal/embeddings') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        const payload = JSON.parse(body) as { texts: string[] };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          provider: 'mock',
          model: 'mock-embedding',
          dimensions: 2,
          inputTokens: 12,
          embeddings: payload.texts.map(() => [1, 0]),
        }));
      });
      return;
    }
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
      res.write('event: agent.usage.reported\n');
      res.write('data: {"node":"respond","provider":"openai-compatible","model":"gpt-test","inputTokens":20,"outputTokens":40,"status":"done"}\n\n');
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
    documentStorageDir: join(rootDir, 'documents'),
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

test('capability catalog merges workspace settings and rejects planned enablement', async () => {
  const catalogResponse = await fetch(`${appBaseUrl}/api/capabilities`, {
    headers: authHeaders,
  });
  assert.equal(catalogResponse.status, 200);
  const catalog = await catalogResponse.json() as {
    capabilities: Array<{ kind: string; name: string; enabled: boolean }>;
  };
  assert.equal(
    catalog.capabilities.find((item) => item.kind === 'memory' && item.name === 'sqlite')?.enabled,
    true,
  );
  assert.equal(
    catalog.capabilities.find((item) => item.kind === 'stt' && item.name === 'openai')?.enabled,
    false,
  );

  const plannedResponse = await fetch(`${appBaseUrl}/api/capabilities/stt/openai`, {
    method: 'PUT',
    headers: jsonAuthHeaders(),
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(plannedResponse.status, 409);
  assert.equal((await plannedResponse.json() as { error: { code: string } }).error.code, 'CAPABILITY_UNAVAILABLE');
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

  const uploadResponse = await fetch(
    `${appBaseUrl}/api/agents/${agent.id}/documents/upload`,
    {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify({
        filename: 'private-guide.md',
        mimeType: 'text/markdown',
        dataBase64: Buffer.from('Private launch date is 2030-05-20.').toString('base64'),
      }),
    },
  );
  assert.equal(uploadResponse.status, 201);
  const document = await uploadResponse.json() as { id: number };
  const indexResponse = await fetch(
    `${appBaseUrl}/api/agents/${agent.id}/documents/${document.id}/index`,
    { method: 'POST', headers: authHeaders },
  );
  assert.equal(indexResponse.status, 202);
  const indexJob = await indexResponse.json() as { job: { id: number } };
  let indexStatus = '';
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(`${appBaseUrl}/api/jobs/${indexJob.job.id}`, {
      headers: authHeaders,
    });
    indexStatus = (await response.json() as { status: string }).status;
    if (indexStatus === 'succeeded') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(indexStatus, 'succeeded');

  const versionResponse = await fetch(`${appBaseUrl}/api/agents/${agent.id}/versions`, {
    method: 'POST',
    headers: authHeaders,
  });
  assert.equal(versionResponse.status, 201);
  const preview = await versionResponse.json() as { version: { id: number } };

  const response = await fetch(`${appBaseUrl}/api/stream`, {
    method: 'POST',
    headers: {
      ...jsonAuthHeaders(),
      'idempotency-key': 'configured-stream-run-1',
    },
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
  const liveEventIds = [...body.matchAll(/^id: (\d+)$/gm)]
    .map((match) => Number(match[1]));
  assert.equal(liveEventIds.length, 6);
  assert.ok(liveEventIds.every((id, index) => (
    index === 0 || id > liveEventIds[index - 1]!
  )));
  assert.equal(
    response.headers.get('x-primalthrum-idempotency-key'),
    'configured-stream-run-1',
  );
  assert.equal(upstreamPayloads.length, 1);
  const upstreamPayload = upstreamPayloads[0] as Record<string, unknown>;
  assert.match(
    String(upstreamPayload.memory_path),
    new RegExp(`^\\.primalthrum/workspaces/\\d+/agents/${agent.id}/memory\\.sqlite3$`),
  );
  const payloadWithoutRuntimePath = { ...upstreamPayload };
  delete payloadWithoutRuntimePath.memory_path;
  assert.deepEqual(payloadWithoutRuntimePath, {
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
    context: '[private-guide.md] Private launch date is 2030-05-20.',
    sources: [{
      title: 'private-guide.md',
      documentId: document.id,
      chunkId: `${document.id}:0`,
    }],
  });

  const runResponse = await fetch(`${appBaseUrl}/api/runs/${runId}`, {
    headers: authHeaders,
  });
  assert.equal(runResponse.status, 200);
  const run = await runResponse.json() as {
    agentId: number;
    agentVersionId: number | null;
    conversationId: number | null;
    idempotencyKey: string | null;
    input: string;
    status: string;
    endedAt: string | null;
    capabilitySnapshot: {
      schemaVersion: string;
      selected: string[];
      settings: Record<string, boolean>;
    };
  };
  assert.equal(run.agentId, agent.id);
  assert.equal(run.agentVersionId, preview.version.id);
  assert.equal(run.conversationId, conversationId);
  assert.equal(run.idempotencyKey, 'configured-stream-run-1');
  assert.equal(run.input, 'Use the saved agent config');
  assert.equal(run.status, 'completed');
  assert.ok(run.endedAt);
  assert.equal(run.capabilitySnapshot.schemaVersion, '1.0');
  assert.ok(run.capabilitySnapshot.selected.includes('tool:file_reader'));
  assert.ok(run.capabilitySnapshot.selected.includes('llm:openai-compatible'));
  assert.equal(run.capabilitySnapshot.settings['tool:file_reader'], true);

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
    'agent.usage.reported',
    'message.completed',
    'agent.run.completed',
  ]);
  assert.equal(events[0]?.node, 'run');
  assert.equal(events[1]?.node, 'intake');
  assert.equal(events[2]?.node, 'act_with_tools');
  assert.equal(events[3]?.payload.inputTokens, 20);
  assert.equal(events[4]?.payload.message, 'Saved assistant response');
  assert.equal(events[5]?.payload.status, 'done');

  const usageDb = createSqliteDatabase(join(rootDir, 'platform.sqlite'));
  const rated = usageDb.query<{ meter: string; credits_charged: number }>(`
    SELECT meter, credits_charged FROM rated_usage_events
    WHERE resource_type = 'run' AND resource_id = ${sqlValue(String(runId))}
    ORDER BY meter;
  `);
  assert.deepEqual(rated.map((item) => item.meter), [
    'api.runs',
    'embedding.tokens',
    'llm.input_tokens',
    'llm.output_tokens',
    'rag.retrievals',
    'tool.calls',
  ]);
  assert.equal(rated.reduce((sum, item) => sum + Number(item.credits_charged), 0), 59);
  const settled = usageDb.query<{ state: string; settled_credits: number }>(`
    SELECT state, settled_credits FROM credit_reservations
    WHERE workspace_id = 1 AND idempotency_key = ${sqlValue(`run:${runId}`)};
  `)[0];
  assert.deepEqual(settled, { state: 'settled', settled_credits: 59 });

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

  const replayResponse = await fetch(`${appBaseUrl}/api/stream`, {
    method: 'POST',
    headers: {
      ...jsonAuthHeaders(),
      'idempotency-key': 'configured-stream-run-1',
    },
    body: JSON.stringify({
      agentId: agent.id,
      versionId: preview.version.id,
      input: 'Use the saved agent config',
    }),
  });
  assert.equal(replayResponse.status, 200);
  assert.equal(Number(replayResponse.headers.get('x-primalthrum-run-id')), runId);
  assert.equal(
    Number(replayResponse.headers.get('x-primalthrum-conversation-id')),
    conversationId,
  );
  assert.equal(await replayResponse.text(), body);
  assert.equal(upstreamPayloads.length, 1);

  const disableResponse = await fetch(`${appBaseUrl}/api/capabilities/tool/file_reader`, {
    method: 'PUT',
    headers: jsonAuthHeaders(),
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(disableResponse.status, 200);

  const disabledRunResponse = await fetch(`${appBaseUrl}/api/stream`, {
    method: 'POST',
    headers: {
      ...jsonAuthHeaders(),
      'idempotency-key': 'configured-stream-run-disabled',
    },
    body: JSON.stringify({
      agentId: agent.id,
      versionId: preview.version.id,
      input: 'Use the saved agent config again',
    }),
  });
  assert.equal(disabledRunResponse.status, 409);
  assert.match(await disabledRunResponse.text(), /tool:file_reader/);
  assert.equal(upstreamPayloads.length, 1);

  const enableResponse = await fetch(`${appBaseUrl}/api/capabilities/tool/file_reader`, {
    method: 'PUT',
    headers: jsonAuthHeaders(),
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(enableResponse.status, 200);

  const reconnectResponse = await fetch(`${appBaseUrl}/api/runs/${runId}/stream`, {
    headers: {
      ...authHeaders,
      'last-event-id': String(liveEventIds[0]),
    },
  });
  assert.equal(reconnectResponse.status, 200);
  const reconnectedBody = await reconnectResponse.text();
  assert.doesNotMatch(
    reconnectedBody,
    new RegExp(`^id: ${liveEventIds[0]}$`, 'm'),
  );
  assert.deepEqual(
    [...reconnectedBody.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1])),
    liveEventIds.slice(1),
  );

  const conflictResponse = await fetch(`${appBaseUrl}/api/stream`, {
    method: 'POST',
    headers: {
      ...jsonAuthHeaders(),
      'idempotency-key': 'configured-stream-run-1',
    },
    body: JSON.stringify({
      agentId: agent.id,
      versionId: preview.version.id,
      input: 'A different request must not reuse the key',
    }),
  });
  assert.equal(conflictResponse.status, 409);
  const conflict = await conflictResponse.json() as { error: { code: string } };
  assert.equal(conflict.error.code, 'RUN_IDEMPOTENCY_CONFLICT');
  assert.equal(upstreamPayloads.length, 1);

  const db = createSqliteDatabase(join(rootDir, 'platform.sqlite'));
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
