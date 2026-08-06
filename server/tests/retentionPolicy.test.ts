import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { SqliteDatabase } from '../src/db/sqlite';
import { LocalDocumentStorage } from '../src/services/fileStorage';
import { JobRepository } from '../src/services/jobRepository';
import { hashPassword } from '../src/services/passwordHash';
import { RetentionPolicyRepository } from '../src/services/retentionPolicyRepository';
import { RetentionScheduler } from '../src/services/retentionScheduler';
import { RetentionService } from '../src/services/retentionService';
import { ToolAuditRepository } from '../src/services/toolAuditRepository';
import { UserRepository } from '../src/services/userRepository';
import { WorkspaceLegalHoldRepository } from '../src/services/workspaceLegalHoldRepository';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('retention enforcement is tenant-scoped, durable, and preserves security audit evidence', async () => {
  const root = temporaryRoot();
  const db = new SqliteDatabase(join(root, 'platform.sqlite'));
  const now = new Date('2026-08-01T12:00:00.000Z');
  const policies = new RetentionPolicyRepository(db, () => now);
  const storage = new LocalDocumentStorage(join(root, 'documents'));
  const retention = new RetentionService(policies, storage);
  const user = new UserRepository(db).createAdmin('retention-owner@example.com', hashPassword('strong password'));

  seedRetentionData(db);
  const oldFile = storage.save({
    workspaceId: 1, agentId: 1, documentId: 1, filename: 'old.txt', content: 'old',
  });
  const recentFile = storage.save({
    workspaceId: 1, agentId: 1, documentId: 2, filename: 'recent.txt', content: 'recent',
  });
  db.run(`
    UPDATE documents SET storage_ref = '${oldFile.storageRef}' WHERE id = 1;
    UPDATE documents SET storage_ref = '${recentFile.storageRef}' WHERE id = 2;
  `);

  assert.deepEqual(policies.preview(1), {
    conversations: 0, runs: 0, documents: 0, documentBytes: 0,
  });
  policies.update({
    workspaceId: 1,
    conversationDays: 30,
    runDays: 7,
    documentDays: 30,
    actorUserId: user.id,
  });
  assert.deepEqual(policies.preview(1), {
    conversations: 1, runs: 1, documents: 1, documentBytes: 3,
  });

  const outcome = await retention.enforce(1, user.id);
  assert.deepEqual(outcome.event.result, {
    conversations: 1,
    runs: 1,
    documents: 1,
    documentBytes: 3,
    filesQueued: 1,
  });
  assert.equal(outcome.filesDeleted, 1);
  assert.equal(outcome.fileDeletionFailures, 0);
  assert.equal(existsSync(oldFile.absolutePath), false);
  assert.equal(existsSync(recentFile.absolutePath), true);

  assert.deepEqual(ids(db, 'conversations'), [2, 3]);
  assert.deepEqual(ids(db, 'conversation_messages'), [2, 3]);
  assert.deepEqual(ids(db, 'runs'), [2, 3, 4]);
  assert.deepEqual(ids(db, 'stream_events'), [2, 3]);
  assert.deepEqual(ids(db, 'documents'), [2, 3]);
  assert.equal(db.query<{ conversation_id: number | null }>(
    'SELECT conversation_id FROM runs WHERE id = 2;',
  )[0]?.conversation_id, null);
  assert.equal(db.query<{ status: string }>('SELECT status FROM jobs WHERE id = 1;')[0]?.status, 'failed');

  const audits = new ToolAuditRepository(db).list(1, 1);
  assert.equal(audits.length, 1);
  assert.equal(audits[0]?.toolName, 'file_reader');
  assert.equal(db.query<{ count: number }>(
    'SELECT COUNT(*) AS count FROM retained_tool_audit_logs;',
  )[0]?.count, 1);
  assert.equal(db.query<{ count: number }>(
    "SELECT COUNT(*) AS count FROM retention_file_deletions WHERE status = 'completed';",
  )[0]?.count, 1);

  assert.throws(() => db.run(`UPDATE retention_events SET result_json = '{}' WHERE id = 1;`), /immutable/);
  assert.equal(policies.preview(1).conversations, 0);
  assert.equal(policies.listEvents(1).length, 2);
  assert.equal(policies.listEvents(2).length, 0);
});

test('retention scheduler creates one durable job for each due workspace', () => {
  const root = temporaryRoot();
  const db = new SqliteDatabase(join(root, 'platform.sqlite'));
  const now = new Date('2026-08-01T12:00:00.000Z');
  const policies = new RetentionPolicyRepository(db, () => now);
  const user = new UserRepository(db).createAdmin('scheduler-owner@example.com', hashPassword('strong password'));
  policies.update({
    workspaceId: 1,
    conversationDays: 90,
    runDays: null,
    documentDays: null,
    actorUserId: user.id,
  });
  const jobs = new JobRepository(db);
  let kicks = 0;
  const scheduler = new RetentionScheduler(policies, jobs, () => { kicks += 1; }, 60_000);

  scheduler.tick();
  scheduler.tick();

  assert.equal(kicks, 1);
  assert.equal(db.query<{ count: number }>(`
    SELECT COUNT(*) AS count FROM jobs WHERE type = 'retention.enforce';
  `)[0]?.count, 1);
  scheduler.stop();
});

test('active legal hold atomically blocks retention records and physical file deletion', async () => {
  const root = temporaryRoot();
  const db = new SqliteDatabase(join(root, 'platform.sqlite'));
  const now = new Date('2026-08-01T12:00:00.000Z');
  const policies = new RetentionPolicyRepository(db, () => now);
  const storage = new LocalDocumentStorage(join(root, 'documents'));
  const retention = new RetentionService(policies, storage);
  const owner = new UserRepository(db).createAdmin('held-owner@example.com', hashPassword('strong password'));
  seedRetentionData(db);
  policies.update({
    workspaceId: 1,
    conversationDays: 30,
    runDays: 7,
    documentDays: 30,
    actorUserId: owner.id,
  });
  db.run(`
    INSERT INTO operator_users (
      email, password_hash, role, must_change_password, bootstrap_root
    ) VALUES ('legal-maker@example.com', 'unused', 'security', 0, 0);
    INSERT INTO retention_file_deletions (workspace_id, storage_ref)
    VALUES (1, 'held/already-queued.txt');
  `);
  new WorkspaceLegalHoldRepository(db, () => now).create({
    workspaceId: 1,
    externalCaseRef: 'RETENTION-HOLD-001',
    basis: 'litigation',
    reason: 'Preserve all Workspace records while the litigation matter remains active.',
    operatorUserId: 1,
  });

  const outcome = await retention.enforce(1, owner.id);

  assert.equal(outcome.blockedByLegalHold, true);
  assert.equal(outcome.event.eventType, 'enforcement_blocked');
  assert.deepEqual(outcome.event.result, { legalHoldCount: 1 });
  assert.equal(outcome.filesDeleted, 0);
  assert.equal(outcome.fileDeletionFailures, 0);
  assert.deepEqual(ids(db, 'conversations'), [1, 2, 3]);
  assert.deepEqual(ids(db, 'runs'), [1, 2, 3, 4]);
  assert.deepEqual(ids(db, 'documents'), [1, 2, 3]);
  assert.equal(db.query<{ status: string }>('SELECT status FROM jobs WHERE id = 1;')[0]?.status, 'queued');
  assert.equal(db.query<{ count: number }>(
    'SELECT COUNT(*) AS count FROM retained_tool_audit_logs;',
  )[0]?.count, 0);
  assert.deepEqual(policies.pendingFileDeletions(1), []);
  assert.equal(policies.get(1).lastEnforcedAt, null);
  assert.equal(policies.get(1).nextEnforcementAt, '2026-08-02T12:00:00.000Z');
});

function seedRetentionData(db: SqliteDatabase): void {
  db.run(`
    INSERT INTO workspaces (id, name, slug) VALUES (2, 'Other', 'other');
    INSERT INTO agents (id, workspace_id, name, slug, path, status)
    VALUES
      (1, 1, 'Primary', 'primary', '/tmp/primary', 'ready'),
      (2, 2, 'Other', 'other-agent', '/tmp/other', 'ready');

    INSERT INTO conversations (id, workspace_id, agent_id, title, created_at, updated_at)
    VALUES
      (1, 1, 1, 'Old', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
      (2, 1, 1, 'Recent', '2026-07-31T00:00:00.000Z', '2026-07-31T00:00:00.000Z'),
      (3, 2, 2, 'Other old', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO conversation_messages (id, workspace_id, conversation_id, role, content, created_at)
    VALUES
      (1, 1, 1, 'user', 'old message', '2026-01-01T00:00:00.000Z'),
      (2, 1, 2, 'user', 'recent message', '2026-07-31T00:00:00.000Z'),
      (3, 2, 3, 'user', 'other message', '2026-01-01T00:00:00.000Z');

    INSERT INTO runs (id, agent_id, workspace_id, input, status, conversation_id, started_at, ended_at)
    VALUES
      (1, 1, 1, 'old run', 'done', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z'),
      (2, 1, 1, 'recent run', 'done', 1, '2026-07-31T00:00:00.000Z', '2026-07-31T00:01:00.000Z'),
      (3, 1, 1, 'active old run', 'running', NULL, '2026-01-01T00:00:00.000Z', NULL),
      (4, 2, 2, 'other old run', 'done', 3, '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z');
    INSERT INTO stream_events (id, run_id, event_type, node, payload_json, created_at)
    VALUES
      (1, 1, 'agent.tool.completed', 'act', '{"tool":"file_reader"}', '2026-01-01T00:00:00.000Z'),
      (2, 2, 'message.completed', 'finalize', '{}', '2026-07-31T00:00:00.000Z'),
      (3, 4, 'message.completed', 'finalize', '{}', '2026-01-01T00:00:00.000Z');
    INSERT INTO tool_audit_logs (
      workspace_id, run_id, event_id, tool_name, status, dangerous, node, payload_json, created_at
    ) VALUES (1, 1, 1, 'file_reader', 'allowed', 0, 'act', '{}', '2026-01-01T00:00:00.000Z');

    INSERT INTO documents (
      id, agent_id, workspace_id, filename, hash, status, collection, mime_type,
      size_bytes, created_at
    ) VALUES
      (1, 1, 1, 'old.txt', 'old-hash', 'indexed', 'default', 'text/plain', 3, '2026-01-01T00:00:00.000Z'),
      (2, 1, 1, 'recent.txt', 'recent-hash', 'indexed', 'default', 'text/plain', 6, '2026-07-31T00:00:00.000Z'),
      (3, 2, 2, 'other.txt', 'other-hash', 'indexed', 'default', 'text/plain', 5, '2026-01-01T00:00:00.000Z');
    INSERT INTO jobs (id, workspace_id, type, status, payload_json, max_attempts, run_at)
    VALUES (1, 1, 'document.index', 'queued', '{"documentId":1}', 3, '2026-08-01T12:00:00.000Z');
  `);
}

function ids(db: SqliteDatabase, table: string): number[] {
  return db.query<{ id: number }>(`SELECT id FROM ${table} ORDER BY id;`).map((row) => Number(row.id));
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'primalthrum-retention-'));
  roots.push(root);
  return root;
}
