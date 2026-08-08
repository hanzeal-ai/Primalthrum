import { randomUUID } from 'node:crypto';

import { PostgresDatabase } from '../db/postgres';
import { runPostgresMigrations } from '../db/postgresMigrations';
import { AsyncAgentRepository } from '../services/asyncAgentRepository';
import { AsyncDocumentUploadSecurityRepository } from '../services/asyncDocumentUploadSecurityRepository';
import { AsyncUserRepository } from '../services/asyncUserRepository';
import { AsyncWorkspaceRepository } from '../services/asyncWorkspaceRepository';
import { parseDocumentUpload } from '../services/documentUpload';

function upload(filename: string, content: string) {
  return parseDocumentUpload({
    filename,
    mimeType: 'text/plain',
    dataBase64: Buffer.from(content).toString('base64'),
  });
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');

  const database = new PostgresDatabase({ connectionString, max: 4 });
  const marker = randomUUID();
  const users = new AsyncUserRepository(database);
  const workspaces = new AsyncWorkspaceRepository(database);
  const agents = new AsyncAgentRepository(database, '/tmp/primalthrum-generated-agents');
  const events = new AsyncDocumentUploadSecurityRepository(database);
  const cleanupWorkspaceIds: number[] = [];
  let userId: number | null = null;
  try {
    await runPostgresMigrations(database);
    const owner = await users.createUser(`upload-security-${marker}@example.com`, 'hash', true);
    userId = owner.id;
    const workspace = await workspaces.create(owner.id, `Upload Security ${marker}`);
    const isolatedWorkspace = await workspaces.create(owner.id, `Upload Isolated ${marker}`);
    cleanupWorkspaceIds.push(workspace.id, isolatedWorkspace.id);
    const agent = await agents.create({ name: `Upload Security ${marker}` }, workspace.id);
    const event = await events.record({
      workspaceId: workspace.id,
      agentId: agent.id,
      userId: owner.id,
      upload: upload(`private-${marker}.txt`, 'sensitive source content'),
      scanner: 'clamav-smoke',
      status: 'rejected',
      threatName: 'Smoke.Signature',
    });
    const listed = await events.list(workspace.id);
    let immutable = false;
    try {
      await database.execute({
        text: 'DELETE FROM document_upload_security_events WHERE event_id = $1;',
        values: [event.eventId],
      });
    } catch (error) {
      if (!(error instanceof Error) || !/immutable/.test(error.message)) throw error;
      immutable = true;
    }
    if (
      !immutable
      || listed.length !== 1
      || listed[0]?.eventId !== event.eventId
      || listed[0]?.filenameHash.length !== 64
      || listed[0]?.contentSha256.length !== 64
      || !listed[0]?.createdAt.endsWith('Z')
      || JSON.stringify(listed).includes(`private-${marker}.txt`)
      || JSON.stringify(listed).includes('sensitive source content')
      || (await events.list(isolatedWorkspace.id)).length !== 0
    ) {
      throw new Error('PostgreSQL upload security repository state is inconsistent');
    }
    process.stdout.write('postgres upload security repository smoke passed\n');
  } finally {
    for (const workspaceId of cleanupWorkspaceIds.reverse()) {
      await database.execute({
        text: 'DELETE FROM workspaces WHERE id = $1;',
        values: [workspaceId],
      }).catch(() => undefined);
    }
    if (userId) {
      await database.execute({
        text: 'DELETE FROM users WHERE id = $1;',
        values: [userId],
      }).catch(() => undefined);
    }
    await database.close();
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'postgres upload security smoke failed'}\n`);
  process.exitCode = 1;
});
