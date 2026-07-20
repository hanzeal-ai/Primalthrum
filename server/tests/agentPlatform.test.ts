import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { type Server } from 'node:http';
import { promisify } from 'node:util';

import { createApp } from '../src/app';

const execFileAsync = promisify(execFile);

let server: Server;
let baseUrl = '';
let rootDir = '';

before(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'primalthrum-platform-'));
  const app = createApp({
    dbPath: join(rootDir, 'platform.sqlite'),
    generatedAgentsDir: join(rootDir, 'generated-agents'),
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(rootDir, { recursive: true, force: true });
});

test('POST /api/agents persists an agent config in SQLite metadata', async () => {
  const response = await fetch(`${baseUrl}/api/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Research Agent',
      description: 'Research assistant with optional RAG',
      memoryProvider: 'sqlite',
      cacheProvider: 'sqlite',
      ragProvider: 'in-memory',
      enabledTools: ['file_reader'],
      enabledSkills: ['research'],
      modelConfig: {
        default: { provider: 'mock', model: 'mock-chat' },
        embedding: { provider: 'mock', model: 'mock-embedding' },
      },
    }),
  });

  assert.equal(response.status, 201);
  const created = await response.json() as { id: number; slug: string; config: unknown };
  assert.equal(created.slug, 'research-agent');
  assert.ok(created.id > 0);

  const listResponse = await fetch(`${baseUrl}/api/agents`);
  assert.equal(listResponse.status, 200);
  const listed = await listResponse.json() as Array<{ id: number; slug: string }>;
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.slug, 'research-agent');
});

test('POST /api/agents/:id/generate writes a standalone agent project', async () => {
  const createResponse = await fetch(`${baseUrl}/api/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Standalone Agent',
      description: 'Standalone demo',
      enabledTools: ['file_reader'],
      enabledSkills: ['research'],
      ragProvider: 'none',
    }),
  });
  const created = await createResponse.json() as { id: number; slug: string; path: string };

  const generateResponse = await fetch(`${baseUrl}/api/agents/${created.id}/generate`, {
    method: 'POST',
  });

  assert.equal(generateResponse.status, 200);
  const generated = await generateResponse.json() as { path: string; files: string[] };
  assert.equal(generated.path, created.path);
  assert.ok(generated.files.includes('src/graph.py'));
  assert.ok(generated.files.includes('src/nodes/retrieve_optional_rag.py'));
  assert.ok(generated.files.includes('tests/test_demo.py'));

  await stat(join(generated.path, 'README.md'));
  const graph = await readFile(join(generated.path, 'src/graph.py'), 'utf8');
  assert.match(graph, /load_context/);
  assert.match(graph, /retrieve_optional_rag/);
  assert.match(graph, /update_memory/);

  const python = resolve(process.cwd(), '..', 'agent', '.venv', 'bin', 'python');
  const { stdout } = await execFileAsync(
    python,
    ['-m', 'src.main', 'Demo task'],
    { cwd: generated.path },
  );
  assert.match(stdout, /Planned task: Demo task with file_reader\./);
});

test('discovery APIs expose typed providers tools and skills', async () => {
  const providersResponse = await fetch(`${baseUrl}/api/providers`);
  assert.equal(providersResponse.status, 200);
  const providers = await providersResponse.json() as {
    llm: Array<{ name: string; status: string; description: string }>;
    memory: Array<{ name: string; status: string; description: string }>;
    cache: Array<{ name: string; status: string; description: string }>;
    rag: Array<{ name: string; status: string; description: string }>;
  };
  assert.ok(providers.llm.some((provider) => provider.name === 'mock' && provider.status === 'available'));
  assert.ok(providers.memory.some((provider) => provider.name === 'null' && provider.status === 'available'));
  assert.ok(providers.cache.some((provider) => provider.name === 'memory' && provider.status === 'available'));
  assert.ok(providers.rag.some((provider) => provider.name === 'in-memory' && provider.status === 'available'));
  assert.ok(providers.rag.some((provider) => provider.name === 'chroma' && provider.status === 'planned'));

  const toolsResponse = await fetch(`${baseUrl}/api/tools`);
  assert.equal(toolsResponse.status, 200);
  const tools = await toolsResponse.json() as Array<{
    name: string;
    description: string;
    status: string;
    permissions: string[];
    dangerous: boolean;
  }>;
  assert.deepEqual(tools[0], {
    name: 'file_reader',
    description: 'Read files under allowed roots.',
    status: 'available',
    permissions: ['fs:read'],
    dangerous: false,
  });

  const skillsResponse = await fetch(`${baseUrl}/api/skills`);
  assert.equal(skillsResponse.status, 200);
  const skills = await skillsResponse.json() as Array<{
    name: string;
    version: string;
    description: string;
    status: string;
    tools: string[];
    rag: boolean;
  }>;
  assert.deepEqual(skills[0], {
    name: 'research',
    version: '0.1.0',
    description: 'Plan, retrieve evidence, act with tools, and summarize.',
    status: 'available',
    tools: ['file_reader'],
    rag: true,
  });
});

test('POST /api/runs creates a pending run for an existing agent', async () => {
  const createAgentResponse = await fetch(`${baseUrl}/api/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Run Agent',
      description: 'Run API demo',
    }),
  });
  const agent = await createAgentResponse.json() as { id: number };

  const createRunResponse = await fetch(`${baseUrl}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      agentId: agent.id,
      input: 'Research the product requirements',
    }),
  });

  assert.equal(createRunResponse.status, 201);
  const run = await createRunResponse.json() as {
    id: number;
    agentId: number;
    input: string;
    status: string;
    startedAt: string;
    endedAt: string | null;
  };
  assert.ok(run.id > 0);
  assert.equal(run.agentId, agent.id);
  assert.equal(run.input, 'Research the product requirements');
  assert.equal(run.status, 'pending');
  assert.ok(run.startedAt);
  assert.equal(run.endedAt, null);

  const getRunResponse = await fetch(`${baseUrl}/api/runs/${run.id}`);
  assert.equal(getRunResponse.status, 200);
  const loaded = await getRunResponse.json() as { id: number; agentId: number };
  assert.equal(loaded.id, run.id);
  assert.equal(loaded.agentId, agent.id);
});

test('POST /api/runs rejects unknown agents', async () => {
  const response = await fetch(`${baseUrl}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      agentId: 999999,
      input: 'This should fail',
    }),
  });

  assert.equal(response.status, 404);
});

test('document APIs register and list agent document metadata', async () => {
  const createAgentResponse = await fetch(`${baseUrl}/api/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Document Agent',
      description: 'Document registry demo',
    }),
  });
  const agent = await createAgentResponse.json() as { id: number };

  const createDocumentResponse = await fetch(
    `${baseUrl}/api/agents/${agent.id}/documents`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: 'guide.md',
        content: '# Guide\nUse this document for retrieval.',
        collection: 'research',
      }),
    },
  );

  assert.equal(createDocumentResponse.status, 201);
  const document = await createDocumentResponse.json() as {
    id: number;
    agentId: number;
    filename: string;
    hash: string;
    indexStatus: string;
    collection: string;
  };
  assert.ok(document.id > 0);
  assert.equal(document.agentId, agent.id);
  assert.equal(document.filename, 'guide.md');
  assert.match(document.hash, /^[a-f0-9]{64}$/);
  assert.equal(document.indexStatus, 'registered');
  assert.equal(document.collection, 'research');

  const listResponse = await fetch(`${baseUrl}/api/agents/${agent.id}/documents`);
  assert.equal(listResponse.status, 200);
  const documents = await listResponse.json() as Array<typeof document>;
  assert.deepEqual(documents, [document]);
});

test('run stream events can be inserted and replayed', async () => {
  const createAgentResponse = await fetch(`${baseUrl}/api/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Event Agent',
      description: 'Event replay demo',
    }),
  });
  const agent = await createAgentResponse.json() as { id: number };

  const createRunResponse = await fetch(`${baseUrl}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      agentId: agent.id,
      input: 'Replay stream events',
    }),
  });
  const run = await createRunResponse.json() as { id: number };

  const createEventResponse = await fetch(`${baseUrl}/api/runs/${run.id}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      eventType: 'agent.node.completed',
      node: 'plan',
      payload: {
        message: 'plan completed',
        status: 'running',
      },
    }),
  });

  assert.equal(createEventResponse.status, 201);
  const event = await createEventResponse.json() as {
    id: number;
    runId: number;
    eventType: string;
    node: string;
    payload: Record<string, unknown>;
    createdAt: string;
  };
  assert.ok(event.id > 0);
  assert.equal(event.runId, run.id);
  assert.equal(event.eventType, 'agent.node.completed');
  assert.equal(event.node, 'plan');
  assert.deepEqual(event.payload, {
    message: 'plan completed',
    status: 'running',
  });
  assert.ok(event.createdAt);

  const listEventsResponse = await fetch(`${baseUrl}/api/runs/${run.id}/events`);
  assert.equal(listEventsResponse.status, 200);
  const events = await listEventsResponse.json() as Array<{ id: number; eventType: string }>;
  assert.deepEqual(events.map((item) => item.id), [event.id]);
  assert.equal(events[0]?.eventType, 'agent.node.completed');
});
