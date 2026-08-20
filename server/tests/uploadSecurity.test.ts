import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { type Server } from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { createApp } from '../src/app';
import { SqliteDatabase } from '../src/db/sqlite';
import { createSqliteDatabase } from '../src/db/databaseFactory';
import {
  ClamAvDocumentMalwareScanner,
  createDocumentMalwareScanner,
  type DocumentMalwareScanner,
  DocumentScanUnavailableError,
  DocumentThreatDetectedError,
} from '../src/services/documentMalwareScanner';
import { parseDocumentUpload, type ParsedDocumentUpload } from '../src/services/documentUpload';
import { DocumentUploadSecurityRepository } from '../src/services/documentUploadSecurityRepository';

class ControlledScanner implements DocumentMalwareScanner {
  readonly name = 'controlled-test';

  async healthCheck(): Promise<void> {}

  async scan(upload: ParsedDocumentUpload) {
    if (upload.content.includes('infected')) {
      throw new DocumentThreatDetectedError(this.name, 'Test.Signature');
    }
    if (upload.content.includes('scanner-down')) {
      throw new DocumentScanUnavailableError(this.name);
    }
    return { scanner: this.name };
  }
}

let rootDir = '';
let dbPath = '';
let storageDir = '';
let server: Server;
let baseUrl = '';
let token = '';
let agentId = 0;

before(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'primalthrum-upload-security-'));
  dbPath = join(rootDir, 'platform.sqlite');
  storageDir = join(rootDir, 'documents');
  server = createApp({
    dbPath,
    documentStorageDir: storageDir,
    generatedAgentsDir: join(rootDir, 'agents'),
    documentMalwareScanner: new ControlledScanner(),
    logger: { log: () => undefined },
  }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;

  const setup = await fetch(`${baseUrl}/api/setup/admin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'upload-security@example.com',
      password: 'correct horse battery staple',
    }),
  });
  assert.equal(setup.status, 201);
  token = (await setup.json() as { session: { token: string } }).session.token;
  const agent = await fetch(`${baseUrl}/api/agents`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ name: 'Upload Security Agent' }),
  });
  assert.equal(agent.status, 201);
  agentId = (await agent.json() as { id: number }).id;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(rootDir, { recursive: true, force: true });
});

test('production upload configuration fails closed without ClamAV', async () => {
  assert.throws(
    () => createDocumentMalwareScanner({ NODE_ENV: 'production' }),
    /CLAMAV_HOST is required/,
  );
  const development = createDocumentMalwareScanner({ NODE_ENV: 'development' });
  assert.equal(development.name, 'development-signature');
  await assert.rejects(
    development.scan(upload(
      'eicar.txt',
      'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
    )),
    DocumentThreatDetectedError,
  );
});

test('ClamAV INSTREAM scanner accepts clean content and rejects a signature', async () => {
  await withClamResponse('stream: OK\0', async (port, received) => {
    const scanner = new ClamAvDocumentMalwareScanner('127.0.0.1', port, 2_000);
    await scanner.scan(upload('clean.txt', 'clean content'));
    assert.equal(received().subarray(0, 10).toString(), 'zINSTREAM\0');
    assert.ok(received().includes(Buffer.from('clean content')));
  });
  await withClamResponse('stream: Eicar-Test-Signature FOUND\0', async (port) => {
    const scanner = new ClamAvDocumentMalwareScanner('127.0.0.1', port, 2_000);
    await assert.rejects(
      scanner.scan(upload('infected.txt', 'infected content')),
      (error: unknown) => (
        error instanceof DocumentThreatDetectedError
        && error.threatName === 'Eicar-Test-Signature'
      ),
    );
  });
});

test('ClamAV readiness requires an exact PONG response', async () => {
  await withClamResponse('PONG\0', async (port, received) => {
    const scanner = new ClamAvDocumentMalwareScanner('127.0.0.1', port, 2_000);
    await scanner.healthCheck();
    assert.equal(received().toString(), 'zPING\0');
  });
  await withClamResponse('ERROR\0', async (port) => {
    const scanner = new ClamAvDocumentMalwareScanner('127.0.0.1', port, 2_000);
    await assert.rejects(scanner.healthCheck(), DocumentScanUnavailableError);
  });
});

test('HTTP uploads fail before persistence and retain minimized immutable scan evidence', async () => {
  const clean = await uploadRequest('clean.txt', 'approved knowledge content');
  assert.equal(clean.status, 201);

  const infected = await uploadRequest('infected.txt', 'infected document payload');
  assert.equal(infected.status, 422);
  assert.equal((await errorCode(infected)), 'DOCUMENT_THREAT_DETECTED');

  const unavailable = await uploadRequest('unavailable.txt', 'scanner-down payload');
  assert.equal(unavailable.status, 503);
  assert.equal((await errorCode(unavailable)), 'DOCUMENT_SCAN_UNAVAILABLE');

  const database = createSqliteDatabase(dbPath);
  const events = new DocumentUploadSecurityRepository(database).list(1);
  assert.deepEqual(events.map((event) => event.status), ['error', 'rejected', 'clean']);
  assert.equal(events.every((event) => event.filenameHash.length === 64), true);
  assert.equal(events.every((event) => event.contentSha256.length === 64), true);
  assert.equal(JSON.stringify(events).includes('approved knowledge content'), false);
  assert.equal(JSON.stringify(events).includes('clean.txt'), false);
  assert.equal(database.query<{ count: number }>(
    `SELECT COUNT(*) AS count FROM documents WHERE agent_id = ${agentId};`,
  )[0]?.count, 1);
  assert.throws(
    () => database.run('DELETE FROM document_upload_security_events WHERE id = 1;'),
    /immutable/,
  );
});

function uploadRequest(filename: string, content: string): Promise<Response> {
  return fetch(`${baseUrl}/api/agents/${agentId}/documents/upload`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({
      filename,
      mimeType: 'text/plain',
      dataBase64: Buffer.from(content).toString('base64'),
    }),
  });
}

function upload(filename: string, content: string): ParsedDocumentUpload {
  return parseDocumentUpload({
    filename,
    mimeType: 'text/plain',
    dataBase64: Buffer.from(content).toString('base64'),
  });
}

function jsonHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  };
}

async function errorCode(response: Response): Promise<string> {
  return (await response.json() as { error: { code: string } }).error.code;
}

async function withClamResponse(
  response: string,
  run: (port: number, received: () => Buffer) => Promise<void>,
): Promise<void> {
  let payload = Buffer.alloc(0);
  const clam: TcpServer = createTcpServer((socket) => {
    socket.on('data', (chunk) => {
      payload = Buffer.concat([payload, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      if (
        payload.equals(Buffer.from('zPING\0'))
        || (payload.length >= 14 && payload.subarray(-4).equals(Buffer.alloc(4)))
      ) {
        socket.end(response);
      }
    });
  });
  await new Promise<void>((resolve) => clam.listen(0, '127.0.0.1', resolve));
  const address = clam.address();
  assert(address && typeof address === 'object');
  try {
    await run(address.port, () => payload);
  } finally {
    await new Promise<void>((resolve) => clam.close(() => resolve()));
  }
}
