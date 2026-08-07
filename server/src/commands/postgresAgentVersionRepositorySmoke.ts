import { randomUUID } from 'node:crypto';

import { PostgresDatabase } from '../db/postgres';
import { runPostgresMigrations } from '../db/postgresMigrations';
import { AsyncAgentRepository } from '../services/asyncAgentRepository';
import { AsyncAgentVersionRepository } from '../services/asyncAgentVersionRepository';
import { AsyncUserRepository } from '../services/asyncUserRepository';
import { AsyncWorkspaceRepository } from '../services/asyncWorkspaceRepository';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');

  const database = new PostgresDatabase({ connectionString, max: 6 });
  const marker = randomUUID();
  const users = new AsyncUserRepository(database);
  const workspaces = new AsyncWorkspaceRepository(database);
  const agents = new AsyncAgentRepository(database, '/tmp/primalthrum-generated-agents');
  const versions = new AsyncAgentVersionRepository(database);
  let workspaceId: number | null = null;
  try {
    await runPostgresMigrations(database);
    const owner = await users.createUser(`version-${marker}@example.com`, 'hash', true);
    const workspace = await workspaces.create(owner.id, `Version ${marker}`);
    workspaceId = workspace.id;
    const agent = await agents.create({ name: `Version ${marker}` }, workspaceId);
    const previews = await Promise.all([
      versions.createPreview(agent, owner.id),
      versions.createPreview(agent, owner.id),
    ]);
    const ordered = previews
      .slice()
      .sort((left, right) => left.version.versionNumber - right.version.versionNumber);
    const first = ordered[0];
    const second = ordered[1];
    if (!first || !second || first.version.versionNumber !== 1 || second.version.versionNumber !== 2) {
      throw new Error('PostgreSQL Agent version allocation is inconsistent');
    }
    await versions.publish(agent, first.version.id, owner.id);
    await versions.publish(agent, second.version.id, owner.id);
    await versions.publish(agent, first.version.id, owner.id, 'rollback');

    const deployments = await versions.listDeployments(agent.id, workspaceId);
    const activeProduction = deployments.filter((deployment) => (
      deployment.environment === 'production' && deployment.status === 'active'
    ));
    const activePreview = deployments.filter((deployment) => (
      deployment.environment === 'preview' && deployment.status === 'active'
    ));
    const resolved = await versions.resolveForRun(agent.id, workspaceId);
    if (
      activeProduction.length !== 1
      || activeProduction[0]?.versionId !== first.version.id
      || activeProduction[0]?.trigger !== 'rollback'
      || activePreview.length !== 0
      || resolved?.id !== first.version.id
    ) {
      throw new Error('PostgreSQL Agent version deployment state is inconsistent');
    }
    process.stdout.write('postgres Agent version repository smoke passed\n');
  } finally {
    if (workspaceId) {
      await database.execute({
        text: 'DELETE FROM workspaces WHERE id = $1;',
        values: [workspaceId],
      }).catch(() => undefined);
    }
    await database.close();
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'postgres version smoke failed'}\n`);
  process.exitCode = 1;
});
