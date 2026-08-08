import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { createServer, type Server } from 'node:http';
import { promisify } from 'node:util';

import { createApp } from '../src/app';
import { type DatabaseAdapter } from '../src/db/adapter';
import { MIGRATIONS } from '../src/db/migrations';
import { SqliteDatabase, sqlValue } from '../src/db/sqlite';
import { createSqliteDatabase } from '../src/db/databaseFactory';
import { InProcessJobWorker } from '../src/services/inProcessJobWorker';
import { JobRepository } from '../src/services/jobRepository';
import { LocalDocumentStorage } from '../src/services/fileStorage';
import { DocumentIndexRepository } from '../src/services/documentIndexRepository';
import { chunkDocumentText } from '../src/services/documentChunker';
import { AgentEmbeddingClient } from '../src/services/agentEmbeddingClient';
import { parseDocumentUpload } from '../src/services/documentUpload';
import { DurableJobDispatcher } from '../src/services/durableJobDispatcher';
import { createBackup, restoreBackup } from '../src/services/backupService';
import { type AgentConfig } from '../src/services/agentRepository';
import { LocalSecretVault } from '../src/services/localSecretVault';
import { ProviderConfigRepository } from '../src/services/providerConfigRepository';
import { RuntimeProviderResolver } from '../src/services/runtimeProviderResolver';
import { CapabilitySettingsRepository } from '../src/services/capabilitySettingsRepository';

const execFileAsync = promisify(execFile);

let server: Server;
let agentRuntimeServer: Server;
let baseUrl = '';
let rootDir = '';
let dbPath = '';
let documentStorageDir = '';
let authHeaders: Record<string, string> = {};

before(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'primalthrum-platform-'));
  dbPath = join(rootDir, 'platform.sqlite');
  documentStorageDir = join(rootDir, 'documents');
  agentRuntimeServer = createServer((request, response) => {
    if (
      request.method === 'POST'
      && request.url === '/internal/speech/transcriptions'
    ) {
      let body = '';
      request.on('data', (chunk) => {
        body += chunk.toString();
      });
      request.on('end', () => {
        const payload = JSON.parse(body) as { provider: { model: string } };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          provider: 'openai-compatible',
          model: payload.provider.model,
          text: 'Create a support agent',
        }));
      });
      return;
    }
    if (
      request.method === 'POST'
      && request.url === '/internal/speech/synthesis'
    ) {
      let body = '';
      request.on('data', (chunk) => {
        body += chunk.toString();
      });
      request.on('end', () => {
        const payload = JSON.parse(body) as { provider: { model: string } };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          provider: 'openai-compatible',
          model: payload.provider.model,
          mimeType: 'audio/mpeg',
          audioBase64: Buffer.from('speech-bytes').toString('base64'),
        }));
      });
      return;
    }
    if (request.method !== 'POST' || request.url !== '/internal/embeddings') {
      response.writeHead(404).end();
      return;
    }
    let body = '';
    request.on('data', (chunk) => {
      body += chunk.toString();
    });
    request.on('end', () => {
      const payload = JSON.parse(body) as { texts: string[] };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        provider: 'mock',
        model: 'mock-embedding',
        dimensions: 2,
        embeddings: payload.texts.map((_, index) => [1, index]),
      }));
    });
  });
  await new Promise<void>((resolve) => {
    agentRuntimeServer.listen(0, '127.0.0.1', resolve);
  });
  const agentAddress = agentRuntimeServer.address();
  assert(agentAddress && typeof agentAddress === 'object');
  const app = createApp({
    agentBaseUrl: `http://127.0.0.1:${agentAddress.port}`,
    dbPath,
    documentStorageDir,
    generatedAgentsDir: join(rootDir, 'generated-agents'),
    logger: { log: () => undefined },
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => agentRuntimeServer.close(() => resolve()));
  rmSync(rootDir, { recursive: true, force: true });
});

function jsonAuthHeaders(): Record<string, string> {
  return {
    ...authHeaders,
    'content-type': 'application/json',
  };
}

async function assertErrorPayload(
  response: Response,
  expected: {
    status: number;
    code: string;
    message: string;
  },
): Promise<void> {
  assert.equal(response.status, expected.status);
  const body = await response.json() as {
    error: {
      code: string;
      message: string;
      status: number;
    };
  };
  assert.deepEqual(body.error, expected);
}

test('schema bootstrap creates the default local workspace', () => {
  const db = createSqliteDatabase(dbPath);
  const workspaces = db.query<{
    id: number;
    name: string;
    slug: string;
  }>(`
    SELECT id, name, slug
    FROM workspaces
    ORDER BY id ASC;
  `);

  assert.deepEqual(workspaces, [
    {
      id: 1,
      name: 'Local Workspace',
      slug: 'local',
    },
  ]);

  for (const tableName of ['agents', 'runs', 'documents', 'provider_configs']) {
    const columns = db.query<{ name: string }>(`PRAGMA table_info(${tableName});`);
    assert.ok(
      columns.some((column) => column.name === 'workspace_id'),
      `${tableName} should include workspace_id`,
    );
  }
});

test('document upload validation enforces type encoding content and size', () => {
  const content = '{"name":"Primalthrum"}';
  const parsed = parseDocumentUpload({
    filename: 'config.json',
    mimeType: 'application/json; charset=utf-8',
    dataBase64: Buffer.from(content).toString('base64'),
    collection: 'product',
  });
  assert.equal(parsed.content, content);
  assert.equal(parsed.mimeType, 'application/json');
  assert.equal(parsed.sizeBytes, Buffer.byteLength(content));
  assert.equal(parsed.collection, 'product');

  assert.throws(() => parseDocumentUpload({
    filename: 'payload.exe',
    mimeType: 'text/plain',
    dataBase64: Buffer.from('unsafe').toString('base64'),
  }), /not supported/);
  assert.throws(() => parseDocumentUpload({
    filename: 'guide.md',
    mimeType: 'application/json',
    dataBase64: Buffer.from('{}').toString('base64'),
  }), /does not match/);
  assert.throws(() => parseDocumentUpload({
    filename: 'broken.json',
    mimeType: 'application/json',
    dataBase64: Buffer.from('{').toString('base64'),
  }), /JSON document is invalid/);
  assert.throws(() => parseDocumentUpload({
    filename: 'bad.txt',
    mimeType: 'text/plain',
    dataBase64: 'not base64',
  }), /dataBase64 is invalid/);
  assert.throws(() => parseDocumentUpload({
    filename: 'large.txt',
    mimeType: 'text/plain',
    dataBase64: Buffer.alloc(2 * 1024 * 1024 + 1, 65).toString('base64'),
  }), /exceeds/);
  for (const filename of ['../secret.txt', 'folder\\secret.txt', '/tmp/secret.txt']) {
    assert.throws(() => parseDocumentUpload({
      filename,
      mimeType: 'text/plain',
      dataBase64: Buffer.from('blocked').toString('base64'),
    }), /base name/);
  }
});

test('document chunking is deterministic and preserves bounded overlap', () => {
  const content = Array.from({ length: 700 }, (_, index) => `token-${index}`).join(' ');
  const chunks = chunkDocumentText(9, content, {
    maxCharacters: 500,
    overlapCharacters: 50,
  });

  assert.ok(chunks.length > 2);
  assert.deepEqual(
    chunks.map((chunk, index) => chunk.chunkId),
    chunks.map((_, index) => `9:${index}`),
  );
  assert.ok(chunks.every((chunk) => Array.from(chunk.text).length <= 500));
  assert.equal(
    Array.from(chunks[0]!.text).slice(-50).join(''),
    Array.from(chunks[1]!.text).slice(0, 50).join(''),
  );
});

test('agent embedding client validates batch responses', async () => {
  const embeddingServer = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/internal/embeddings') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      provider: 'mock',
      model: 'mock-embedding',
      dimensions: 2,
      embeddings: [[1, 0], [0, 1]],
    }));
  });
  await new Promise<void>((resolve) => embeddingServer.listen(0, '127.0.0.1', resolve));
  const address = embeddingServer.address();
  assert(address && typeof address === 'object');

  try {
    const result = await new AgentEmbeddingClient(
      `http://127.0.0.1:${address.port}`,
    ).embed(
      { provider: 'mock', model: 'mock-embedding' },
      ['first', 'second'],
    );
    assert.equal(result.dimensions, 2);
    assert.deepEqual(result.embeddings, [[1, 0], [0, 1]]);
  } finally {
    await new Promise<void>((resolve) => embeddingServer.close(() => resolve()));
  }
});

test('schema migrations are ordered and idempotent', () => {
  const migrationRootDir = mkdtempSync(join(tmpdir(), 'primalthrum-migrations-'));
  try {
    const db = new SqliteDatabase(join(migrationRootDir, 'platform.sqlite'));
    const adapter: DatabaseAdapter = db;
    assert.equal(typeof adapter.run, 'function');
    assert.equal(typeof adapter.query, 'function');

    db.run(`
      CREATE TABLE schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    db.run('DROP TABLE schema_migrations;');

    const app = createApp({
      dbPath: join(migrationRootDir, 'platform.sqlite'),
      documentStorageDir: join(migrationRootDir, 'documents'),
      generatedAgentsDir: join(migrationRootDir, 'generated-agents'),
      logger: { log: () => undefined },
      startBackgroundSchedulers: false,
    });
    void app;
    const afterFirstRun = db.query<{ id: string }>(`
      SELECT id
      FROM schema_migrations
      ORDER BY id ASC;
    `);

    const secondApp = createApp({
      dbPath: join(migrationRootDir, 'platform.sqlite'),
      documentStorageDir: join(migrationRootDir, 'documents-2'),
      generatedAgentsDir: join(migrationRootDir, 'generated-agents-2'),
      logger: { log: () => undefined },
      startBackgroundSchedulers: false,
    });
    void secondApp;
    const afterSecondRun = db.query<{ id: string }>(`
      SELECT id
      FROM schema_migrations
      ORDER BY id ASC;
    `);

    assert.deepEqual(
      afterFirstRun.map((migration) => migration.id),
      MIGRATIONS.map((migration) => migration.id),
    );
    assert.deepEqual(afterSecondRun, afterFirstRun);

    const workspaces = db.query<{ count: number }>(`
      SELECT COUNT(*) AS count
      FROM workspaces
      WHERE slug = 'local';
    `);
    assert.equal(Number(workspaces[0]?.count ?? 0), 1);
  } finally {
    rmSync(migrationRootDir, { recursive: true, force: true });
  }
});

test('Workspace invitation email migration preserves existing delivery evidence', () => {
  const migrationRootDir = mkdtempSync(join(tmpdir(), 'primalthrum-email-migration-'));
  try {
    const db = new SqliteDatabase(join(migrationRootDir, 'platform.sqlite'));
    for (const migration of MIGRATIONS.slice(0, -1)) migration.up(db);
    db.run(`
      INSERT INTO users (workspace_id, email, password_hash, role)
      VALUES (1, 'migration@example.com', 'hash', 'user');
      INSERT INTO account_email_outbox (
        user_id, template, recipient_email, payload_json, status,
        provider, provider_message_id, last_provider_status
      ) VALUES (
        1, 'verify_email', 'migration@example.com', '{}', 'delivered',
        'resend', 'existing-message', 'delivered'
      );
    `);

    MIGRATIONS[MIGRATIONS.length - 1]?.up(db);

    assert.deepEqual(db.query<{
      template: string;
      workspace_id: number | null;
      provider_message_id: string;
    }>(`
      SELECT template, workspace_id, provider_message_id
      FROM account_email_outbox;
    `), [{
      template: 'verify_email',
      workspace_id: null,
      provider_message_id: 'existing-message',
    }]);
    db.run(`
      INSERT INTO account_email_outbox (
        workspace_id, invitation_id, template, recipient_email, payload_json
      ) VALUES (1, 9, 'workspace_invitation', 'invitee@example.com', '{}');
    `);
  } finally {
    rmSync(migrationRootDir, { recursive: true, force: true });
  }
});

test('in-process job worker records retry and failure states', async () => {
  const jobRootDir = mkdtempSync(join(tmpdir(), 'primalthrum-jobs-'));
  try {
    const db = createSqliteDatabase(join(jobRootDir, 'platform.sqlite'));
    const jobs = new JobRepository(db);
    const worker = new InProcessJobWorker(jobs);
    const job = jobs.create({
      type: 'demo.failure',
      payload: { purpose: 'retry coverage' },
      maxAttempts: 2,
    });

    const firstAttempt = await worker.run(job.id, () => {
      throw new Error('first failure');
    });
    assert.equal(firstAttempt.status, 'retrying');
    assert.equal(firstAttempt.attempts, 1);
    assert.equal(firstAttempt.error, 'first failure');

    const secondAttempt = await worker.run(job.id, () => {
      throw new Error('final failure');
    });
    assert.equal(secondAttempt.status, 'failed');
    assert.equal(secondAttempt.attempts, 2);
    assert.equal(secondAttempt.error, 'final failure');
  } finally {
    rmSync(jobRootDir, { recursive: true, force: true });
  }
});

test('durable dispatcher recovers interrupted jobs and retries from SQLite state', async () => {
  const dispatcherRootDir = mkdtempSync(join(tmpdir(), 'primalthrum-dispatcher-'));
  try {
    const db = createSqliteDatabase(join(dispatcherRootDir, 'platform.sqlite'));
    const jobs = new JobRepository(db);
    const queued = jobs.create({
      type: 'document.index',
      payload: { documentId: 7 },
      maxAttempts: 4,
    });
    jobs.markRunning(queued.id);
    let calls = 0;
    const dispatcher = new DurableJobDispatcher(jobs, {
      'document.index': (payload) => {
        calls += 1;
        if (calls === 1) throw new Error('temporary index failure');
        return { documentId: payload.documentId, indexed: true };
      },
    });

    dispatcher.resume();
    for (let attempt = 0; attempt < 20 && jobs.findById(queued.id)?.status !== 'succeeded'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const completed = jobs.findById(queued.id);
    assert.equal(completed?.status, 'succeeded');
    assert.equal(completed?.attempts, 3);
    assert.deepEqual(completed?.result, { documentId: 7, indexed: true });
  } finally {
    rmSync(dispatcherRootDir, { recursive: true, force: true });
  }
});

test('local document storage saves reads and deletes files', () => {
  const storageRootDir = mkdtempSync(join(tmpdir(), 'primalthrum-storage-'));
  try {
    const storage = new LocalDocumentStorage(storageRootDir);
    const saved = storage.save({
      workspaceId: 1,
      agentId: 2,
      documentId: 3,
      filename: '../guide.md',
      content: '# Guide\nStored content.',
    });

    assert.match(saved.storageRef, /^local:\/\/documents\//);
    assert.equal(storage.read(saved.storageRef), '# Guide\nStored content.');

    storage.delete(saved.storageRef);
    assert.throws(() => storage.read(saved.storageRef), /ENOENT/);
  } finally {
    rmSync(storageRootDir, { recursive: true, force: true });
  }
});

test('backup service restores metadata database and document files', () => {
  const backupRootDir = mkdtempSync(join(tmpdir(), 'primalthrum-backup-'));
  try {
    const dbPathForBackup = join(backupRootDir, 'platform.sqlite');
    const documentDirForBackup = join(backupRootDir, 'documents');
    const backupDir = join(backupRootDir, 'backup');
    const db = createSqliteDatabase(dbPathForBackup);
    db.run(`
      CREATE TABLE marker (value TEXT NOT NULL);
      INSERT INTO marker VALUES ('before');
    `);
    const storage = new LocalDocumentStorage(documentDirForBackup);
    const saved = storage.save({
      workspaceId: 1,
      agentId: 1,
      documentId: 1,
      filename: 'guide.md',
      content: 'original',
    });

    createBackup({
      dbPath: dbPathForBackup,
      documentStorageDir: documentDirForBackup,
      backupDir,
    });

    db.run("UPDATE marker SET value = 'after';");
    storage.save({
      workspaceId: 1,
      agentId: 1,
      documentId: 1,
      filename: 'guide.md',
      content: 'mutated',
    });

    restoreBackup({
      dbPath: dbPathForBackup,
      documentStorageDir: documentDirForBackup,
      backupDir,
    });

    const rows = db.query<{ value: string }>('SELECT value FROM marker;');
    assert.equal(rows[0]?.value, 'before');
    assert.equal(storage.read(saved.storageRef), 'original');
  } finally {
    rmSync(backupRootDir, { recursive: true, force: true });
  }
});

test('admin setup login session and logout enforce platform auth', async () => {
  const healthResponse = await fetch(`${baseUrl}/health`);
  assert.equal(healthResponse.status, 200);

  const unauthenticatedAgents = await fetch(`${baseUrl}/api/agents`);
  assert.equal(unauthenticatedAgents.status, 401);

  const setupStatusResponse = await fetch(`${baseUrl}/api/setup/status`);
  assert.equal(setupStatusResponse.status, 200);
  assert.deepEqual(await setupStatusResponse.json(), { needsSetup: true });

  const setupResponse = await fetch(`${baseUrl}/api/setup/admin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'admin@example.com',
      password: 'correct horse battery staple',
    }),
  });
  assert.equal(setupResponse.status, 201);
  const setup = await setupResponse.json() as {
    user: { id: number; email: string; role: string };
    session: { token: string; expiresAt: string };
  };
  assert.ok(setup.user.id > 0);
  assert.equal(setup.user.email, 'admin@example.com');
  assert.equal(setup.user.role, 'owner');
  assert.ok(setup.session.token);
  assert.ok(setup.session.expiresAt);
  authHeaders = { authorization: `Bearer ${setup.session.token}` };

  const duplicateSetupResponse = await fetch(`${baseUrl}/api/setup/admin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'another-admin@example.com',
      password: 'correct horse battery staple',
    }),
  });
  assert.equal(duplicateSetupResponse.status, 409);

  const sessionResponse = await fetch(`${baseUrl}/api/auth/session`, {
    headers: authHeaders,
  });
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json() as {
    user: { email: string; role: string };
  };
  assert.equal(session.user.email, 'admin@example.com');
  assert.equal(session.user.role, 'owner');

  const logoutResponse = await fetch(`${baseUrl}/api/auth/logout`, {
    method: 'POST',
    headers: authHeaders,
  });
  assert.equal(logoutResponse.status, 204);

  const revokedSessionResponse = await fetch(`${baseUrl}/api/auth/session`, {
    headers: authHeaders,
  });
  assert.equal(revokedSessionResponse.status, 401);

  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'admin@example.com',
      password: 'correct horse battery staple',
    }),
  });
  assert.equal(loginResponse.status, 200);
  const login = await loginResponse.json() as {
    user: { email: string; role: string };
    session: { token: string };
  };
  assert.equal(login.user.email, 'admin@example.com');
  assert.equal(login.user.role, 'owner');
  authHeaders = { authorization: `Bearer ${login.session.token}` };
});

test('readiness checks dependencies and metrics exports counters', async () => {
  const readinessRootDir = mkdtempSync(join(tmpdir(), 'primalthrum-readiness-'));
  const agentHealthServer = createServer((request, response) => {
    if (request.url === '/ready') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ status: 'ready', service: 'agent' }));
      return;
    }

    response.statusCode = 404;
    response.end();
  });

  try {
    await new Promise<void>((resolve) => {
      agentHealthServer.listen(0, '127.0.0.1', resolve);
    });
    const agentAddress = agentHealthServer.address();
    assert(agentAddress && typeof agentAddress === 'object');

    const readinessApp = createApp({
      agentBaseUrl: `http://127.0.0.1:${agentAddress.port}`,
      dbPath: join(readinessRootDir, 'platform.sqlite'),
      documentStorageDir: join(readinessRootDir, 'documents'),
      generatedAgentsDir: join(readinessRootDir, 'generated-agents'),
      logger: { log: () => undefined },
    });
    const readinessServer = readinessApp.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => readinessServer.once('listening', resolve));
    const readinessAddress = readinessServer.address();
    assert(readinessAddress && typeof readinessAddress === 'object');
    const readinessBaseUrl = `http://127.0.0.1:${readinessAddress.port}`;

    try {
      const readyResponse = await fetch(`${readinessBaseUrl}/ready`);
      assert.equal(readyResponse.status, 200);
      const readyBody = await readyResponse.json() as {
        status: string;
        checks: Array<{ name: string; status: string }>;
      };
      assert.equal(readyBody.status, 'ready');
      assert.deepEqual(
        readyBody.checks.map((check) => [check.name, check.status]),
        [
          ['database', 'ok'],
          ['agent_runtime', 'ok'],
          ['document_storage', 'ok'],
        ],
      );

      const metricsResponse = await fetch(`${readinessBaseUrl}/metrics`);
      assert.equal(metricsResponse.status, 200);
      assert.match(
        metricsResponse.headers.get('content-type') ?? '',
        /^text\/plain/,
      );
      const metrics = await metricsResponse.text();
      assert.match(metrics, /primalthrum_http_requests_total/);
      assert.match(metrics, /primalthrum_process_uptime_seconds/);
      assert.match(metrics, /path="\/ready"/);
    } finally {
      await new Promise<void>((resolve) => readinessServer.close(() => resolve()));
    }
  } finally {
    await new Promise<void>((resolve) => agentHealthServer.close(() => resolve()));
    rmSync(readinessRootDir, { recursive: true, force: true });
  }
});

test('POST /api/agents persists an agent config in SQLite metadata', async () => {
  const response = await fetch(`${baseUrl}/api/agents`, {
    method: 'POST',
    headers: jsonAuthHeaders(),
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
  const created = await response.json() as {
    id: number;
    slug: string;
    workspaceId: number;
    config: { audience: string };
  };
  assert.equal(created.slug, 'research-agent');
  assert.ok(created.id > 0);
  assert.equal(created.workspaceId, 1);
  assert.equal(created.config.audience, 'workspace');

  const privatePublicResponse = await fetch(`${baseUrl}/api/public/agents/${created.slug}`);
  assert.equal(privatePublicResponse.status, 404);

  const listResponse = await fetch(`${baseUrl}/api/agents`, {
    headers: authHeaders,
  });
  assert.equal(listResponse.status, 200);
  const listed = await listResponse.json() as Array<{
    id: number;
    slug: string;
    workspaceId: number;
  }>;
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.slug, 'research-agent');
  assert.equal(listed[0]?.workspaceId, 1);

  const slugResponse = await fetch(`${baseUrl}/api/agents/slug/${created.slug}`, {
    headers: authHeaders,
  });
  assert.equal(slugResponse.status, 200);
  const bySlug = await slugResponse.json() as { id: number; slug: string };
  assert.equal(bySlug.id, created.id);
  assert.equal(bySlug.slug, created.slug);
});

test('POST /api/agents/:id/generate writes a standalone agent project', async () => {
  const createResponse = await fetch(`${baseUrl}/api/agents`, {
    method: 'POST',
    headers: jsonAuthHeaders(),
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
    headers: authHeaders,
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

  const initialVersionsResponse = await fetch(
    `${baseUrl}/api/agents/${created.id}/versions`,
    { headers: authHeaders },
  );
  assert.equal(initialVersionsResponse.status, 200);
  const initialVersions = await initialVersionsResponse.json() as Array<{
    id: number;
    versionNumber: number;
    status: string;
    checksum: string;
    config: { audience: string };
  }>;
  assert.equal(initialVersions.length, 1);
  assert.equal(initialVersions[0]?.versionNumber, 1);
  assert.equal(initialVersions[0]?.status, 'published');
  assert.equal(initialVersions[0]?.config.audience, 'workspace');
  assert.match(initialVersions[0]?.checksum ?? '', /^[a-f0-9]{64}$/);

  const initialDeploymentsResponse = await fetch(
    `${baseUrl}/api/agents/${created.id}/deployments`,
    { headers: authHeaders },
  );
  assert.equal(initialDeploymentsResponse.status, 200);
  const initialDeployments = await initialDeploymentsResponse.json() as Array<{
    versionId: number;
    environment: string;
    status: string;
    trigger: string;
  }>;
  assert.ok(initialDeployments.some((deployment) => (
    deployment.versionId === initialVersions[0]?.id
      && deployment.environment === 'production'
      && deployment.status === 'active'
      && deployment.trigger === 'publish'
  )));

  const audienceResponse = await fetch(`${baseUrl}/api/agents/${created.id}/audience`, {
    method: 'PUT',
    headers: jsonAuthHeaders(),
    body: JSON.stringify({ audience: 'public' }),
  });
  assert.equal(audienceResponse.status, 200);
  const published = await audienceResponse.json() as { config: { audience: string } };
  assert.equal(published.config.audience, 'public');

  const publicResponse = await fetch(`${baseUrl}/api/public/agents/${created.slug}`);
  assert.equal(publicResponse.status, 200);
  const publicAgent = await publicResponse.json() as Record<string, unknown>;
  assert.equal(publicAgent.slug, created.slug);
  assert.equal(publicAgent.name, 'Standalone Agent');
  assert.equal('config' in publicAgent, false);
  assert.equal('path' in publicAgent, false);

  const versionsAfterAudienceResponse = await fetch(
    `${baseUrl}/api/agents/${created.id}/versions`,
    { headers: authHeaders },
  );
  const versionsAfterAudience = await versionsAfterAudienceResponse.json() as Array<{
    id: number;
    versionNumber: number;
    status: string;
    checksum: string;
    config: { audience: string };
  }>;
  assert.equal(versionsAfterAudience.length, 2);
  const versionOne = versionsAfterAudience.find((version) => version.versionNumber === 1);
  const versionTwo = versionsAfterAudience.find((version) => version.versionNumber === 2);
  assert(versionOne);
  assert(versionTwo);
  assert.equal(versionOne.checksum, initialVersions[0]?.checksum);
  assert.equal(versionOne.config.audience, 'workspace');
  assert.equal(versionTwo.config.audience, 'public');

  const rollbackResponse = await fetch(
    `${baseUrl}/api/agents/${created.id}/versions/${versionOne.id}/rollback`,
    { method: 'POST', headers: authHeaders },
  );
  assert.equal(rollbackResponse.status, 200);
  assert.equal((await fetch(`${baseUrl}/api/public/agents/${created.slug}`)).status, 404);

  const republishResponse = await fetch(
    `${baseUrl}/api/agents/${created.id}/versions/${versionTwo.id}/publish`,
    { method: 'POST', headers: authHeaders },
  );
  assert.equal(republishResponse.status, 200);
  assert.equal((await fetch(`${baseUrl}/api/public/agents/${created.slug}`)).status, 200);

  const finalVersionsResponse = await fetch(
    `${baseUrl}/api/agents/${created.id}/versions`,
    { headers: authHeaders },
  );
  const finalVersions = await finalVersionsResponse.json() as typeof versionsAfterAudience;
  assert.deepEqual(finalVersions, versionsAfterAudience);

  const deploymentsResponse = await fetch(
    `${baseUrl}/api/agents/${created.id}/deployments`,
    { headers: authHeaders },
  );
  const deployments = await deploymentsResponse.json() as Array<{
    environment: string;
    status: string;
    trigger: string;
    versionId: number;
  }>;
  assert.equal(
    deployments.filter((deployment) => (
      deployment.environment === 'production' && deployment.status === 'active'
    )).length,
    1,
  );
  assert.ok(deployments.some((deployment) => (
    deployment.trigger === 'rollback' && deployment.versionId === versionOne.id
  )));
  assert.ok(deployments.some((deployment) => (
    deployment.trigger === 'publish' && deployment.versionId === versionTwo.id
  )));
});

test('discovery APIs expose typed providers tools and skills', async () => {
  const providersResponse = await fetch(`${baseUrl}/api/providers`, {
    headers: authHeaders,
  });
  assert.equal(providersResponse.status, 200);
  const providers = await providersResponse.json() as {
    llm: Array<{ name: string; status: string; description: string }>;
    embedding: Array<{ name: string; status: string; description: string }>;
    memory: Array<{ name: string; status: string; description: string }>;
    cache: Array<{ name: string; status: string; description: string }>;
    rag: Array<{ name: string; status: string; description: string }>;
  };
  assert.ok(providers.llm.some((provider) => provider.name === 'mock' && provider.status === 'available'));
  assert.ok(providers.llm.some((provider) => provider.name === 'openai' && provider.status === 'available'));
  assert.ok(providers.llm.some((provider) => provider.name === 'anthropic' && provider.status === 'available'));
  assert.ok(providers.embedding.some((provider) => provider.name === 'openai' && provider.status === 'available'));
  assert.ok(providers.memory.some((provider) => provider.name === 'null' && provider.status === 'available'));
  assert.ok(providers.cache.some((provider) => provider.name === 'memory' && provider.status === 'available'));
  assert.ok(providers.rag.some((provider) => provider.name === 'in-memory' && provider.status === 'available'));
  assert.ok(providers.rag.some((provider) => provider.name === 'chroma' && provider.status === 'planned'));

  const toolsResponse = await fetch(`${baseUrl}/api/tools`, {
    headers: authHeaders,
  });
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

  const skillsResponse = await fetch(`${baseUrl}/api/skills`, {
    headers: authHeaders,
  });
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

test('provider config APIs store secrets as redacted references', async () => {
  const invalidProviderResponse = await fetch(`${baseUrl}/api/provider-configs`, {
    method: 'POST',
    headers: jsonAuthHeaders(),
    body: JSON.stringify({
      type: 'llm',
      config: { provider: 'openai' },
    }),
  });
  await assertErrorPayload(invalidProviderResponse, {
    status: 400,
    code: 'PROVIDER_CONFIG_INVALID',
    message: 'provider config name is required',
  });

  const createResponse = await fetch(`${baseUrl}/api/provider-configs`, {
    method: 'POST',
    headers: jsonAuthHeaders(),
    body: JSON.stringify({
      name: 'openai-production',
      type: 'llm',
      config: {
        provider: 'openai',
        model: 'gpt-5-mini',
      },
      secret: 'sk-live-secret-value',
    }),
  });

  assert.equal(createResponse.status, 201);
  const created = await createResponse.json() as {
    id: number;
    name: string;
    type: string;
    config: Record<string, unknown>;
    secretRef: string;
  };
  assert.ok(created.id > 0);
  assert.equal(created.name, 'openai-production');
  assert.equal(created.type, 'llm');
  assert.deepEqual(created.config, {
    provider: 'openai',
    model: 'gpt-5-mini',
  });
  assert.match(created.secretRef, /^secret:\/\/local\//);
  assert.doesNotMatch(JSON.stringify(created), /sk-live-secret-value/);

  const listResponse = await fetch(`${baseUrl}/api/provider-configs`, {
    headers: authHeaders,
  });
  assert.equal(listResponse.status, 200);
  const listed = await listResponse.json() as Array<typeof created>;
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0], created);
  assert.doesNotMatch(JSON.stringify(listed), /sk-live-secret-value/);

  const updateResponse = await fetch(`${baseUrl}/api/provider-configs/${created.id}`, {
    method: 'PUT',
    headers: jsonAuthHeaders(),
    body: JSON.stringify({
      config: {
        provider: 'openai',
        model: 'gpt-5',
      },
      secret: 'sk-rotated-secret-value',
    }),
  });
  assert.equal(updateResponse.status, 200);
  const updated = await updateResponse.json() as typeof created;
  assert.equal(updated.id, created.id);
  assert.equal(updated.secretRef, created.secretRef);
  assert.deepEqual(updated.config, {
    provider: 'openai',
    model: 'gpt-5',
  });
  assert.doesNotMatch(JSON.stringify(updated), /sk-rotated-secret-value/);

  const db = createSqliteDatabase(dbPath);
  const storedSecrets = db.query<{
    secret_ref: string;
    ciphertext: string;
  }>(`
    SELECT secret_ref, ciphertext
    FROM secrets
    WHERE secret_ref = ${sqlValue(updated.secretRef)};
  `);
  assert.equal(storedSecrets.length, 1);
  assert.notEqual(storedSecrets[0]?.ciphertext, 'sk-live-secret-value');
  assert.notEqual(storedSecrets[0]?.ciphertext, 'sk-rotated-secret-value');
  assert.doesNotMatch(JSON.stringify(storedSecrets), /sk-live-secret-value/);
  assert.doesNotMatch(JSON.stringify(storedSecrets), /sk-rotated-secret-value/);

  const providerRepository = new ProviderConfigRepository(db);
  const secretVault = new LocalSecretVault(db);
  const resolver = new RuntimeProviderResolver(providerRepository, secretVault);
  const runtimeConfig: AgentConfig = {
    memoryProvider: 'null',
    cacheProvider: 'memory',
    ragProvider: 'none',
    enabledTools: [],
    enabledSkills: [],
    modelConfig: {
      default: {
        provider: 'openai',
        providerConfigId: updated.id,
        model: 'gpt-5',
      },
      embedding: { provider: 'mock', model: 'mock-embedding' },
    },
    audience: 'workspace',
  };
  assert.deepEqual(await resolver.resolve(runtimeConfig, 1), {
    llm: {
      provider: 'openai',
      model: 'gpt-5',
      api_key: 'sk-rotated-secret-value',
    },
    embedding: { provider: 'mock', model: 'mock-embedding' },
  });
  assert.throws(() => secretVault.read(updated.secretRef, 2), /secret not found/);

  assert.throws(() => providerRepository.create({
    name: 'unsafe-provider-endpoint',
    type: 'llm',
    config: {
      provider: 'openai-compatible',
      model: 'unsafe-model',
      baseUrl: 'http://attacker.example/v1',
    },
    secret: 'must-not-be-forwarded',
  }, 1), /must use HTTPS/);
});

test('speech APIs resolve encrypted STT and TTS provider configs', async () => {
  async function createSpeechProvider(type: 'stt' | 'tts', model: string) {
    const response = await fetch(`${baseUrl}/api/provider-configs`, {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify({
        name: `${type}-integration`,
        type,
        config: {
          provider: 'openai-compatible',
          model,
          baseUrl: 'https://speech.example/v1',
        },
        secret: `${type}-secret-value`,
      }),
    });
    assert.equal(response.status, 201);
    return response.json() as Promise<{ id: number }>;
  }

  const stt = await createSpeechProvider('stt', 'gpt-4o-mini-transcribe');
  const tts = await createSpeechProvider('tts', 'gpt-4o-mini-tts');
  const transcriptionResponse = await fetch(`${baseUrl}/api/speech/transcriptions`, {
    method: 'POST',
    headers: { ...jsonAuthHeaders(), 'idempotency-key': 'speech-stt-1' },
    body: JSON.stringify({
      providerConfigId: stt.id,
      filename: 'recording.webm',
      mimeType: 'audio/webm',
      audioBase64: Buffer.from('webm-audio').toString('base64'),
      durationMs: 2500,
    }),
  });
  assert.equal(transcriptionResponse.status, 200);
  assert.deepEqual(await transcriptionResponse.json(), {
    provider: 'openai-compatible',
    model: 'gpt-4o-mini-transcribe',
    text: 'Create a support agent',
  });

  const synthesisResponse = await fetch(`${baseUrl}/api/speech/synthesis`, {
    method: 'POST',
    headers: { ...jsonAuthHeaders(), 'idempotency-key': 'speech-tts-1' },
    body: JSON.stringify({
      providerConfigId: tts.id,
      text: 'The agent is ready.',
      voice: 'alloy',
    }),
  });
  assert.equal(synthesisResponse.status, 200);
  assert.deepEqual(await synthesisResponse.json(), {
    provider: 'openai-compatible',
    model: 'gpt-4o-mini-tts',
    mimeType: 'audio/mpeg',
    audioBase64: Buffer.from('speech-bytes').toString('base64'),
  });
  const speechUsage = createSqliteDatabase(dbPath).query<{
    meter: string;
    quantity: number;
    credits_charged: number;
  }>(`
    SELECT meter, quantity, credits_charged
    FROM rated_usage_events
    WHERE resource_type IN ('speech.transcription', 'speech.synthesis')
    ORDER BY meter;
  `);
  assert.deepEqual(speechUsage, [
    { meter: 'speech.synthesis_characters', quantity: 19, credits_charged: 15 },
    { meter: 'speech.transcription_seconds', quantity: 3, credits_charged: 20 },
  ]);

  const capabilitySettings = new CapabilitySettingsRepository(createSqliteDatabase(dbPath));
  capabilitySettings.set(1, 'tts:openai-compatible', false, 1);
  const disabledSynthesisResponse = await fetch(`${baseUrl}/api/speech/synthesis`, {
    method: 'POST',
    headers: jsonAuthHeaders(),
    body: JSON.stringify({
      providerConfigId: tts.id,
      text: 'This request must be blocked.',
    }),
  });
  assert.equal(disabledSynthesisResponse.status, 409);
  assert.deepEqual(await disabledSynthesisResponse.json(), {
    error: {
      code: 'CAPABILITY_DISABLED',
      message: 'runtime capabilities are disabled: tts:openai-compatible',
      status: 409,
      details: { capabilities: ['tts:openai-compatible'] },
    },
  });
  capabilitySettings.set(1, 'tts:openai-compatible', true, 1);

  const invalidAudioResponse = await fetch(`${baseUrl}/api/speech/transcriptions`, {
    method: 'POST',
    headers: jsonAuthHeaders(),
    body: JSON.stringify({
      providerConfigId: stt.id,
      filename: 'recording.exe',
      mimeType: 'application/octet-stream',
      audioBase64: Buffer.from('invalid').toString('base64'),
    }),
  });
  assert.equal(invalidAudioResponse.status, 400);
});

test('POST /api/runs creates a pending run for an existing agent', async () => {
  const createAgentResponse = await fetch(`${baseUrl}/api/agents`, {
    method: 'POST',
    headers: jsonAuthHeaders(),
    body: JSON.stringify({
      name: 'Run Agent',
      description: 'Run API demo',
    }),
  });
  const agent = await createAgentResponse.json() as { id: number; workspaceId: number };

  const createRunResponse = await fetch(`${baseUrl}/api/runs`, {
    method: 'POST',
    headers: jsonAuthHeaders(),
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
    workspaceId: number;
    status: string;
    startedAt: string;
    endedAt: string | null;
  };
  assert.ok(run.id > 0);
  assert.equal(run.agentId, agent.id);
  assert.equal(run.workspaceId, agent.workspaceId);
  assert.equal(run.input, 'Research the product requirements');
  assert.equal(run.status, 'pending');
  assert.ok(run.startedAt);
  assert.equal(run.endedAt, null);

  const getRunResponse = await fetch(`${baseUrl}/api/runs/${run.id}`, {
    headers: authHeaders,
  });
  assert.equal(getRunResponse.status, 200);
  const loaded = await getRunResponse.json() as {
    id: number;
    agentId: number;
    workspaceId: number;
  };
  assert.equal(loaded.id, run.id);
  assert.equal(loaded.agentId, agent.id);
  assert.equal(loaded.workspaceId, agent.workspaceId);
});

test('POST /api/runs rejects unknown agents', async () => {
  const response = await fetch(`${baseUrl}/api/runs`, {
    method: 'POST',
    headers: jsonAuthHeaders(),
    body: JSON.stringify({
      agentId: 999999,
      input: 'This should fail',
    }),
  });

  await assertErrorPayload(response, {
    status: 404,
    code: 'RUN_AGENT_NOT_FOUND',
    message: 'agent not found',
  });
});

test('document APIs register and list agent document metadata', async () => {
  const createAgentResponse = await fetch(`${baseUrl}/api/agents`, {
    method: 'POST',
    headers: jsonAuthHeaders(),
    body: JSON.stringify({
      name: 'Document Agent',
      description: 'Document registry demo',
      ragProvider: 'in-memory',
    }),
  });
  const agent = await createAgentResponse.json() as { id: number; workspaceId: number };

  const createDocumentResponse = await fetch(
    `${baseUrl}/api/agents/${agent.id}/documents`,
    {
      method: 'POST',
      headers: jsonAuthHeaders(),
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
    workspaceId: number;
    filename: string;
    hash: string;
    indexStatus: string;
    collection: string;
    storageRef: string;
    mimeType: string;
    sizeBytes: number;
  };
  assert.ok(document.id > 0);
  assert.equal(document.agentId, agent.id);
  assert.equal(document.workspaceId, agent.workspaceId);
  assert.equal(document.filename, 'guide.md');
  assert.match(document.hash, /^[a-f0-9]{64}$/);
  assert.equal(document.indexStatus, 'registered');
  assert.equal(document.collection, 'research');
  assert.match(document.storageRef, /^local:\/\/documents\//);
  assert.equal(
    new LocalDocumentStorage(documentStorageDir).read(document.storageRef),
    '# Guide\nUse this document for retrieval.',
  );

  const uploadContent = 'topic,owner\nRAG,Platform';
  const uploadResponse = await fetch(
    `${baseUrl}/api/agents/${agent.id}/documents/upload`,
    {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify({
        filename: 'owners.csv',
        mimeType: 'text/csv',
        dataBase64: Buffer.from(uploadContent).toString('base64'),
        collection: 'research',
      }),
    },
  );
  assert.equal(uploadResponse.status, 201);
  const uploaded = await uploadResponse.json() as {
    mimeType: string;
    sizeBytes: number;
    storageRef: string;
  };
  assert.equal(uploaded.mimeType, 'text/csv');
  assert.equal(uploaded.sizeBytes, Buffer.byteLength(uploadContent));
  assert.equal(
    new LocalDocumentStorage(documentStorageDir).read(uploaded.storageRef),
    uploadContent,
  );

  const rejectedUpload = await fetch(
    `${baseUrl}/api/agents/${agent.id}/documents/upload`,
    {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify({
        filename: 'owners.csv',
        mimeType: 'application/json',
        dataBase64: Buffer.from(uploadContent).toString('base64'),
      }),
    },
  );
  assert.equal(rejectedUpload.status, 400);

  const listResponse = await fetch(`${baseUrl}/api/agents/${agent.id}/documents`, {
    headers: authHeaders,
  });
  assert.equal(listResponse.status, 200);
  const documents = await listResponse.json() as Array<typeof document>;
  assert.equal(documents.length, 2);
  assert.deepEqual(documents[0], document);
  assert.equal(documents[1]?.filename, 'owners.csv');
  assert.equal(documents[1]?.mimeType, 'text/csv');
  assert.equal(documents[1]?.sizeBytes, Buffer.byteLength(uploadContent));
  const storageUsage = createSqliteDatabase(dbPath).query<{ quantity: number }>(`
    SELECT quantity FROM rated_usage_events
    WHERE resource_type = 'document.storage'
    ORDER BY id DESC LIMIT 2;
  `);
  assert.deepEqual(
    storageUsage.map((item) => Number(item.quantity)).sort((left, right) => left - right),
    [document.sizeBytes, Buffer.byteLength(uploadContent)].sort((left, right) => left - right),
  );

  const indexResponse = await fetch(
    `${baseUrl}/api/agents/${agent.id}/documents/${document.id}/index`,
    { method: 'POST', headers: authHeaders },
  );
  assert.equal(indexResponse.status, 202);
  const acceptedIndex = await indexResponse.json() as typeof document & {
    job: {
      id: number;
      type: string;
      status: string;
      attempts: number;
      payload: Record<string, unknown>;
    };
  };
  assert.equal(acceptedIndex.id, document.id);
  assert.equal(acceptedIndex.indexStatus, 'indexing');
  assert.ok(acceptedIndex.job.id > 0);
  assert.equal(acceptedIndex.job.type, 'document.index');
  assert.equal(acceptedIndex.job.status, 'queued');
  assert.equal(acceptedIndex.job.attempts, 0);
  assert.deepEqual(acceptedIndex.job.payload, {
    agentId: agent.id,
    documentId: document.id,
  });

  type CompletedIndexJob = {
    status: string;
    attempts: number;
    result: {
      document?: typeof document;
      indexEntryCount?: number;
      embeddingDimensions?: number;
      vectorStore?: string;
    };
  };
  let completedJob: CompletedIndexJob | null = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const jobResponse = await fetch(`${baseUrl}/api/jobs/${acceptedIndex.job.id}`, {
      headers: authHeaders,
    });
    completedJob = await jobResponse.json() as CompletedIndexJob;
    if (completedJob?.status === 'succeeded') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(completedJob?.status, 'succeeded');
  assert.equal(completedJob?.attempts, 1);
  assert.equal(completedJob?.result.indexEntryCount, 1);
  assert.equal(completedJob?.result.embeddingDimensions, 2);
  assert.equal(completedJob?.result.vectorStore, 'in-memory');
  const indexed = completedJob?.result.document;
  assert.equal(indexed?.id, document.id);
  assert.equal(indexed?.indexStatus, 'indexed');
  const db = createSqliteDatabase(dbPath);
  const indexedEntries = db.query<{ count: number }>(`
    SELECT COUNT(*) AS count
    FROM document_index_entries
    WHERE document_id = ${sqlValue(document.id)};
  `);
  assert.equal(Number(indexedEntries[0]?.count ?? 0), 1);
  const persistedVector = db.query<{
    embedding_json: string;
    embedding_provider: string;
    embedding_model: string;
    vector_store: string;
  }>(`
    SELECT embedding_json, embedding_provider, embedding_model, vector_store
    FROM document_index_entries
    WHERE document_id = ${sqlValue(document.id)};
  `)[0];
  assert.deepEqual(JSON.parse(persistedVector?.embedding_json ?? '[]'), [1, 0]);
  assert.equal(persistedVector?.embedding_provider, 'mock');
  assert.equal(persistedVector?.embedding_model, 'mock-embedding');
  assert.equal(persistedVector?.vector_store, 'in-memory');
  const indexUsage = db.query<{ resource_type: string; credits_charged: number }>(`
    SELECT resource_type, credits_charged FROM rated_usage_events
    WHERE resource_type IN ('document.embedding', 'document.rag-storage')
      AND json_extract(metadata_json, '$.documentId') = ${sqlValue(document.id)}
    ORDER BY resource_type;
  `);
  assert.deepEqual(indexUsage, [
    { resource_type: 'document.embedding', credits_charged: 2 },
    { resource_type: 'document.rag-storage', credits_charged: 3 },
  ]);
  const matches = new DocumentIndexRepository(db).searchByAgent(
    agent.id,
    'Use the guide for retrieval',
  );
  assert.equal(matches[0]?.title, 'guide.md');
  assert.ok((matches[0]?.score ?? 0) > 0);

  const indexRepository = new DocumentIndexRepository(db);
  indexRepository.reindex(document, [
    { chunkId: `${document.id}:0`, text: 'Vector result A' },
    { chunkId: `${document.id}:1`, text: 'Vector result B' },
  ], {
    embeddings: [[1, 0], [0, 1]],
    embeddingProvider: 'mock',
    embeddingModel: 'mock-embedding',
    vectorStore: 'in-memory',
  });
  const vectorMatches = indexRepository.searchByAgent(
    agent.id,
    'semantic query',
    2,
    {
      queryEmbedding: [0.9, 0.1],
      embeddingProvider: 'mock',
      embeddingModel: 'mock-embedding',
      vectorStore: 'in-memory',
    },
  );
  assert.equal(vectorMatches[0]?.chunkId, `${document.id}:0`);
  assert.equal(vectorMatches[0]?.embeddingModel, 'mock-embedding');

  const reindexResponse = await fetch(
    `${baseUrl}/api/agents/${agent.id}/documents/${document.id}/index`,
    { method: 'POST', headers: authHeaders },
  );
  assert.equal(reindexResponse.status, 202);
  const reindexAccepted = await reindexResponse.json() as {
    indexStatus: string;
    job: { id: number };
  };
  assert.equal(reindexAccepted.indexStatus, 'indexing');
  let reindexJob: { status: string } | null = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/jobs/${reindexAccepted.job.id}`, {
      headers: authHeaders,
    });
    reindexJob = await response.json() as { status: string };
    if (reindexJob.status === 'succeeded') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(reindexJob?.status, 'succeeded');
  const reindexedEntries = db.query<{ count: number }>(`
    SELECT COUNT(*) AS count
    FROM document_index_entries
    WHERE document_id = ${sqlValue(document.id)};
  `);
  assert.equal(Number(reindexedEntries[0]?.count ?? 0), 1);

  const jobResponse = await fetch(`${baseUrl}/api/jobs/${acceptedIndex.job.id}`, {
    headers: authHeaders,
  });
  assert.equal(jobResponse.status, 200);
  const loadedJob = await jobResponse.json() as { id: number; status: string };
  assert.equal(loadedJob.id, acceptedIndex.job.id);
  assert.equal(loadedJob.status, 'succeeded');

  const deleteResponse = await fetch(
    `${baseUrl}/api/agents/${agent.id}/documents/${document.id}`,
    { method: 'DELETE', headers: authHeaders },
  );
  assert.equal(deleteResponse.status, 200);
  const deleted = await deleteResponse.json() as {
    documentId: number;
    deleted: boolean;
    removedIndexEntries: number;
  };
  assert.deepEqual(deleted, {
    documentId: document.id,
    deleted: true,
    removedIndexEntries: 1,
  });
  const deletedEntries = db.query<{ count: number }>(`
    SELECT COUNT(*) AS count
    FROM document_index_entries
    WHERE document_id = ${sqlValue(document.id)};
  `);
  assert.equal(Number(deletedEntries[0]?.count ?? 0), 0);
  assert.throws(
    () => new LocalDocumentStorage(documentStorageDir).read(document.storageRef),
    /ENOENT/,
  );

  const missingDocumentResponse = await fetch(
    `${baseUrl}/api/agents/${agent.id}/documents/${document.id}/index`,
    { method: 'POST', headers: authHeaders },
  );
  await assertErrorPayload(missingDocumentResponse, {
    status: 404,
    code: 'DOCUMENT_NOT_FOUND',
    message: 'document not found',
  });
});

test('job API returns standard error payload for missing jobs', async () => {
  const response = await fetch(`${baseUrl}/api/jobs/999999`, {
    headers: authHeaders,
  });

  await assertErrorPayload(response, {
    status: 404,
    code: 'JOB_NOT_FOUND',
    message: 'job not found',
  });
});

test('run stream events can be inserted and replayed', async () => {
  const createAgentResponse = await fetch(`${baseUrl}/api/agents`, {
    method: 'POST',
    headers: jsonAuthHeaders(),
    body: JSON.stringify({
      name: 'Event Agent',
      description: 'Event replay demo',
    }),
  });
  const agent = await createAgentResponse.json() as { id: number };

  const createRunResponse = await fetch(`${baseUrl}/api/runs`, {
    method: 'POST',
    headers: jsonAuthHeaders(),
    body: JSON.stringify({
      agentId: agent.id,
      input: 'Replay stream events',
    }),
  });
  const run = await createRunResponse.json() as { id: number };

  const createEventResponse = await fetch(`${baseUrl}/api/runs/${run.id}/events`, {
    method: 'POST',
    headers: jsonAuthHeaders(),
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

  const createToolEventResponse = await fetch(`${baseUrl}/api/runs/${run.id}/events`, {
    method: 'POST',
    headers: jsonAuthHeaders(),
    body: JSON.stringify({
      eventType: 'agent.tool.called',
      node: 'act_with_tools',
      payload: {
        tool: 'file_reader',
        status: 'allowed',
        dangerous: false,
        message: 'file_reader executed',
      },
    }),
  });
  assert.equal(createToolEventResponse.status, 201);
  const toolEvent = await createToolEventResponse.json() as { id: number };

  const listEventsResponse = await fetch(`${baseUrl}/api/runs/${run.id}/events`, {
    headers: authHeaders,
  });
  assert.equal(listEventsResponse.status, 200);
  const events = await listEventsResponse.json() as Array<{ id: number; eventType: string }>;
  assert.deepEqual(events.map((item) => item.id), [event.id, toolEvent.id]);
  assert.equal(events[0]?.eventType, 'agent.node.completed');

  const auditResponse = await fetch(`${baseUrl}/api/audit/tool-calls?runId=${run.id}`, {
    headers: authHeaders,
  });
  assert.equal(auditResponse.status, 200);
  const auditRecords = await auditResponse.json() as Array<{
    runId: number;
    eventId: number;
    toolName: string;
    status: string;
    dangerous: boolean;
    node: string;
    payload: Record<string, unknown>;
  }>;
  assert.equal(auditRecords.length, 1);
  assert.equal(auditRecords[0]?.runId, run.id);
  assert.equal(auditRecords[0]?.eventId, toolEvent.id);
  assert.equal(auditRecords[0]?.toolName, 'file_reader');
  assert.equal(auditRecords[0]?.status, 'allowed');
  assert.equal(auditRecords[0]?.dangerous, false);
  assert.equal(auditRecords[0]?.node, 'act_with_tools');
  assert.deepEqual(auditRecords[0]?.payload, {
    tool: 'file_reader',
    status: 'allowed',
    dangerous: false,
    message: 'file_reader executed',
  });
});
