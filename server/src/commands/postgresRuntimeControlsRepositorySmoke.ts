import { randomUUID } from 'node:crypto';

import { PostgresDatabase } from '../db/postgres';
import { runPostgresMigrations } from '../db/postgresMigrations';
import { AsyncAgentRepository } from '../services/asyncAgentRepository';
import { AsyncCapabilitySettingsRepository } from '../services/asyncCapabilitySettingsRepository';
import { AsyncRunRepository } from '../services/asyncRunRepository';
import { AsyncStreamEventRepository } from '../services/asyncStreamEventRepository';
import { AsyncToolAuditRepository } from '../services/asyncToolAuditRepository';
import { AsyncUserRepository } from '../services/asyncUserRepository';
import { AsyncWorkspaceRepository } from '../services/asyncWorkspaceRepository';
import { CapabilityDisabledError } from '../services/capabilitySettingsRepository';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');

  const database = new PostgresDatabase({ connectionString, max: 4 });
  const marker = randomUUID();
  const users = new AsyncUserRepository(database);
  const workspaces = new AsyncWorkspaceRepository(database);
  const agents = new AsyncAgentRepository(database, '/tmp/primalthrum-generated-agents');
  const runs = new AsyncRunRepository(database);
  const events = new AsyncStreamEventRepository(database);
  const capabilities = new AsyncCapabilitySettingsRepository(database);
  const audits = new AsyncToolAuditRepository(database);
  const cleanupWorkspaceIds: number[] = [];
  let userId: number | null = null;
  try {
    await runPostgresMigrations(database);
    const owner = await users.createUser(`runtime-controls-${marker}@example.com`, 'hash', true);
    userId = owner.id;
    const workspace = await workspaces.create(owner.id, `Runtime Controls ${marker}`);
    const isolatedWorkspace = await workspaces.create(owner.id, `Runtime Isolated ${marker}`);
    cleanupWorkspaceIds.push(workspace.id, isolatedWorkspace.id);

    await Promise.all([
      capabilities.set(workspace.id, 'rag:null', false, owner.id),
      capabilities.set(workspace.id, 'rag:none', false, owner.id),
    ]);
    const snapshot = await capabilities.snapshot(workspace.id, ['rag:null', 'tool:file_reader']);
    let disabled = false;
    try {
      capabilities.assertEnabled(snapshot);
    } catch (error) {
      if (!(error instanceof CapabilityDisabledError)) throw error;
      disabled = true;
    }

    const agent = await agents.create({ name: `Runtime Controls ${marker}` }, workspace.id);
    const run = await runs.create({ agentId: agent.id, input: 'PostgreSQL runtime controls' });
    const event = await events.create({
      runId: run.id,
      eventType: 'agent.tool.completed',
      node: 'act_with_tools',
      payload: { tool: 'web_search', status: 'completed', dangerous: true },
    });
    const [firstAudit, duplicateAudit] = await Promise.all([
      audits.recordStreamEvent(event),
      audits.recordStreamEvent(event),
    ]);
    const listed = await audits.list(workspace.id, run.id);
    if (
      !disabled
      || snapshot.selected.join(',') !== 'rag:none,tool:file_reader'
      || (await capabilities.list(workspace.id)).length !== 1
      || (await capabilities.list(isolatedWorkspace.id)).length !== 0
      || !firstAudit
      || firstAudit.id !== duplicateAudit?.id
      || firstAudit.workspaceId !== workspace.id
      || !firstAudit.createdAt.endsWith('Z')
      || listed.length !== 1
      || listed[0]?.toolName !== 'web_search'
      || listed[0]?.dangerous !== true
      || (await audits.list(isolatedWorkspace.id)).length !== 0
    ) {
      throw new Error('PostgreSQL runtime control repository state is inconsistent');
    }
    process.stdout.write('postgres runtime controls repository smoke passed\n');
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
  process.stderr.write(`${error instanceof Error ? error.message : 'postgres runtime controls smoke failed'}\n`);
  process.exitCode = 1;
});
