import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAsyncSqliteDatabase } from '../src/db/asyncDatabaseFactory';
import { AsyncAgentRepository } from '../src/services/asyncAgentRepository';
import { AsyncRetentionPolicyRepository } from '../src/services/asyncRetentionPolicyRepository';
import { AsyncUserRepository } from '../src/services/asyncUserRepository';
import { LocalDocumentStorage } from '../src/services/fileStorage';
import { RetentionService } from '../src/services/retentionService';

test('async retention enforces tenant data and durable file deletion evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'primalthrum-async-retention-'));
  const database = createAsyncSqliteDatabase(join(root, 'database.sqlite'));
  const now = new Date('2026-08-01T12:00:00.000Z');
  const policies = new AsyncRetentionPolicyRepository(database, () => now);
  const storage = new LocalDocumentStorage(join(root, 'documents'));
  const retention = new RetentionService(policies, storage);
  try {
    const owner = await new AsyncUserRepository(database).createAdmin('retention@example.com', 'hash');
    const agent = await new AsyncAgentRepository(database, join(root, 'agents')).create(
      { name: 'Retention Agent' },
      owner.workspaceId,
    );
    const oldFile = storage.save({
      workspaceId: owner.workspaceId,
      agentId: agent.id,
      documentId: 1,
      filename: 'old.txt',
      content: 'old',
    });
    const conversations = await database.query<{ id: number }>({
      text: `
        INSERT INTO conversations (
          workspace_id, agent_id, title, created_at, updated_at
        ) VALUES ($1, $2, 'Old', $3, $3) RETURNING id;
      `,
      values: [owner.workspaceId, agent.id, '2026-01-01T00:00:00.000Z'],
    });
    const conversationId = Number(conversations[0]?.id);
    const runs = await database.query<{ id: number }>({
      text: `
        INSERT INTO runs (
          agent_id, workspace_id, input, status, conversation_id, started_at, ended_at
        ) VALUES ($1, $2, 'old run', 'done', $3, $4, $4) RETURNING id;
      `,
      values: [agent.id, owner.workspaceId, conversationId, '2026-01-01T00:00:00.000Z'],
    });
    const runId = Number(runs[0]?.id);
    const events = await database.query<{ id: number }>({
      text: `
        INSERT INTO stream_events (run_id, event_type, node, payload_json, created_at)
        VALUES ($1, 'agent.tool.completed', 'act', '{}', $2) RETURNING id;
      `,
      values: [runId, '2026-01-01T00:00:00.000Z'],
    });
    await database.execute({
      text: `
        INSERT INTO tool_audit_logs (
          workspace_id, run_id, event_id, tool_name, status,
          dangerous, node, payload_json, created_at
        ) VALUES ($1, $2, $3, 'file_reader', 'allowed', $4, 'act', '{}', $5);
      `,
      values: [owner.workspaceId, runId, Number(events[0]?.id), false, '2026-01-01T00:00:00.000Z'],
    });
    await database.execute({
      text: `
        INSERT INTO documents (
          id, agent_id, workspace_id, filename, hash, status, collection,
          mime_type, size_bytes, storage_ref, created_at
        ) VALUES (1, $1, $2, 'old.txt', 'old-hash', 'indexed', 'default',
          'text/plain', 3, $3, $4);
      `,
      values: [agent.id, owner.workspaceId, oldFile.storageRef, '2026-01-01T00:00:00.000Z'],
    });
    await database.execute({
      text: `
        INSERT INTO jobs (workspace_id, type, status, payload_json, max_attempts, run_at)
        VALUES ($1, 'document.index', 'queued', $2, 3, $3);
      `,
      values: [owner.workspaceId, JSON.stringify({ documentId: 1 }), now.toISOString()],
    });

    await policies.update({
      workspaceId: owner.workspaceId,
      conversationDays: 30,
      runDays: 7,
      documentDays: 30,
      actorUserId: owner.id,
    });
    assert.deepEqual(await policies.preview(owner.workspaceId), {
      conversations: 1,
      runs: 1,
      documents: 1,
      documentBytes: 3,
    });
    assert.deepEqual(await policies.dueWorkspaceIds(), [owner.workspaceId]);

    const outcome = await retention.enforce(owner.workspaceId, owner.id);
    assert.deepEqual(outcome.event.result, {
      conversations: 1,
      runs: 1,
      documents: 1,
      documentBytes: 3,
      filesQueued: 1,
    });
    assert.equal(outcome.filesDeleted, 1);
    assert.equal(existsSync(oldFile.absolutePath), false);
    assert.equal(await count(database, 'conversations'), 0);
    assert.equal(await count(database, 'runs'), 0);
    assert.equal(await count(database, 'documents'), 0);
    assert.equal(await count(database, 'retained_tool_audit_logs'), 1);
    assert.equal(await count(database, 'retention_file_deletions', "status = 'completed'"), 1);
    const jobs = await database.query<{ status: string }>({
      text: "SELECT status FROM jobs WHERE type = 'document.index' LIMIT 1;",
    });
    assert.equal(jobs[0]?.status, 'failed');
    assert.deepEqual(await policies.dueWorkspaceIds(), []);
  } finally {
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

async function count(
  database: ReturnType<typeof createAsyncSqliteDatabase>,
  table: string,
  condition = '1 = 1',
): Promise<number> {
  const rows = await database.query<{ count: number }>({
    text: `SELECT COUNT(*) AS count FROM ${table} WHERE ${condition};`,
  });
  return Number(rows[0]?.count ?? 0);
}
