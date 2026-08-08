import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAsyncSqliteDatabase } from '../src/db/asyncDatabaseFactory';
import { type AsyncSqliteDatabase } from '../src/db/asyncSqlite';
import { AsyncAgentRepository } from '../src/services/asyncAgentRepository';
import { AsyncDocumentUploadSecurityRepository } from '../src/services/asyncDocumentUploadSecurityRepository';
import { AsyncUserRepository } from '../src/services/asyncUserRepository';
import { AsyncWorkspaceRepository } from '../src/services/asyncWorkspaceRepository';
import { parseDocumentUpload } from '../src/services/documentUpload';

function createDatabase(): { database: AsyncSqliteDatabase; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'primalthrum-async-upload-security-'));
  return {
    database: createAsyncSqliteDatabase(join(root, 'database.sqlite')),
    root,
  };
}

function upload(filename: string, content: string) {
  return parseDocumentUpload({
    filename,
    mimeType: 'text/plain',
    dataBase64: Buffer.from(content).toString('base64'),
  });
}

test('async upload security evidence is minimized, immutable, and tenant-scoped', async () => {
  const { database, root } = createDatabase();
  const users = new AsyncUserRepository(database);
  const workspaces = new AsyncWorkspaceRepository(database);
  const agents = new AsyncAgentRepository(database, join(root, 'generated-agents'));
  const events = new AsyncDocumentUploadSecurityRepository(database);
  try {
    const owner = await users.createUser('async-upload-security@example.com', 'hash', true);
    const workspace = await workspaces.create(owner.id, 'Upload Security');
    const isolatedWorkspace = await workspaces.create(owner.id, 'Upload Security Isolated');
    const agent = await agents.create({ name: 'Upload Security Agent' }, workspace.id);

    const clean = await events.record({
      workspaceId: workspace.id,
      agentId: agent.id,
      userId: owner.id,
      upload: upload('customer-guide.txt', 'approved knowledge'),
      scanner: 'clamav',
      status: 'clean',
    });
    const rejected = await events.record({
      workspaceId: workspace.id,
      agentId: agent.id,
      userId: owner.id,
      upload: upload('malware.txt', 'blocked payload'),
      scanner: 'clamav',
      status: 'rejected',
      threatName: 'Test.Signature',
    });

    const listed = await events.list(workspace.id, 999);
    assert.deepEqual(listed.map((event) => event.status), ['rejected', 'clean']);
    assert.equal(listed[0]?.eventId, rejected.eventId);
    assert.equal(listed[1]?.eventId, clean.eventId);
    assert.equal(listed.every((event) => event.filenameHash.length === 64), true);
    assert.equal(listed.every((event) => event.contentSha256.length === 64), true);
    assert.equal(listed.every((event) => event.createdAt.endsWith('Z')), true);
    assert.equal(JSON.stringify(listed).includes('customer-guide.txt'), false);
    assert.equal(JSON.stringify(listed).includes('approved knowledge'), false);
    assert.deepEqual(await events.list(isolatedWorkspace.id), []);
    await assert.rejects(
      database.execute({
        text: 'DELETE FROM document_upload_security_events WHERE event_id = $1;',
        values: [clean.eventId],
      }),
      /immutable/,
    );
  } finally {
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
