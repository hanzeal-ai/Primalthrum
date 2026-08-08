import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAsyncSqliteDatabase } from '../src/db/asyncDatabaseFactory';
import { type AsyncSqliteDatabase } from '../src/db/asyncSqlite';
import { AsyncAgentRepository } from '../src/services/asyncAgentRepository';
import { AsyncCapabilitySettingsRepository } from '../src/services/asyncCapabilitySettingsRepository';
import { AsyncRunRepository } from '../src/services/asyncRunRepository';
import { AsyncStreamEventRepository } from '../src/services/asyncStreamEventRepository';
import { AsyncToolAuditRepository } from '../src/services/asyncToolAuditRepository';
import { AsyncUserRepository } from '../src/services/asyncUserRepository';
import { AsyncWorkspaceRepository } from '../src/services/asyncWorkspaceRepository';
import { CapabilityDisabledError } from '../src/services/capabilitySettingsRepository';

function createDatabase(): { database: AsyncSqliteDatabase; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'primalthrum-async-runtime-controls-'));
  return {
    database: createAsyncSqliteDatabase(join(root, 'database.sqlite')),
    root,
  };
}

test('async runtime controls preserve capability and Tool audit tenant boundaries', async () => {
  const { database, root } = createDatabase();
  const users = new AsyncUserRepository(database);
  const workspaces = new AsyncWorkspaceRepository(database);
  const agents = new AsyncAgentRepository(database, join(root, 'generated-agents'));
  const runs = new AsyncRunRepository(database);
  const events = new AsyncStreamEventRepository(database);
  const capabilities = new AsyncCapabilitySettingsRepository(database);
  const audits = new AsyncToolAuditRepository(database);
  try {
    const owner = await users.createUser('runtime-controls@example.com', 'hash', true);
    const workspace = await workspaces.create(owner.id, 'Runtime Controls');
    const isolatedWorkspace = await workspaces.create(owner.id, 'Runtime Controls Isolated');

    await Promise.all([
      capabilities.set(workspace.id, 'memory:none', false, owner.id),
      capabilities.set(workspace.id, 'memory:null', false, owner.id),
    ]);
    const settings = await capabilities.list(workspace.id);
    assert.deepEqual(settings.map((setting) => setting.capabilityKey), ['memory:null']);
    assert.ok(settings[0]?.updatedAt.endsWith('Z'));
    assert.deepEqual(await capabilities.list(isolatedWorkspace.id), []);
    const snapshot = await capabilities.snapshot(workspace.id, ['memory:none', 'tool:file_reader']);
    assert.deepEqual(snapshot.selected, ['memory:null', 'tool:file_reader']);
    assert.equal(snapshot.settings['memory:null'], false);
    assert.throws(() => capabilities.assertEnabled(snapshot), CapabilityDisabledError);

    const agent = await agents.create({ name: 'Runtime Controls Agent' }, workspace.id);
    const run = await runs.create({ agentId: agent.id, input: 'Audit the tool call' });
    const event = await events.create({
      runId: run.id,
      eventType: 'agent.tool.called',
      node: 'act_with_tools',
      payload: { tool: 'file_reader', status: 'allowed', dangerous: false },
    });
    const [firstAudit, duplicateAudit] = await Promise.all([
      audits.recordStreamEvent(event),
      audits.recordStreamEvent(event),
    ]);
    assert.equal(firstAudit?.id, duplicateAudit?.id);
    assert.equal(firstAudit?.workspaceId, workspace.id);
    assert.ok(firstAudit?.createdAt.endsWith('Z'));
    assert.deepEqual(await audits.list(isolatedWorkspace.id), []);

    await database.transaction(async (transaction) => {
      await transaction.execute({
        text: `
          INSERT INTO retained_tool_audit_logs (
            original_audit_id, workspace_id, run_id, event_id, tool_name,
            status, dangerous, node, payload_json, created_at
          )
          SELECT id, workspace_id, run_id, event_id, tool_name,
            status, dangerous, node, payload_json, created_at
          FROM tool_audit_logs WHERE event_id = $1;
        `,
        values: [event.id],
      });
      await transaction.execute({
        text: 'DELETE FROM tool_audit_logs WHERE event_id = $1;',
        values: [event.id],
      });
    });
    const retained = await audits.list(workspace.id, run.id);
    assert.equal(retained.length, 1);
    assert.equal(retained[0]?.eventId, event.id);
    assert.equal(retained[0]?.toolName, 'file_reader');

    const nonToolEvent = await events.create({
      runId: run.id,
      eventType: 'agent.node.completed',
      node: 'plan',
      payload: { status: 'completed' },
    });
    assert.equal(await audits.recordStreamEvent(nonToolEvent), null);
  } finally {
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
