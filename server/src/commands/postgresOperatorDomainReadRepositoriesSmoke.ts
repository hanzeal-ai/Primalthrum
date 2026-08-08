import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { PostgresDatabase } from '../db/postgres';
import { runPostgresMigrations } from '../db/postgresMigrations';
import { AsyncAgentRepository } from '../services/asyncAgentRepository';
import { AsyncJobRepository } from '../services/asyncJobRepository';
import { AsyncOperatorCustomerReadRepository } from '../services/asyncOperatorCustomerReadRepository';
import { AsyncOperatorRuntimeReadRepository } from '../services/asyncOperatorRuntimeReadRepository';
import { AsyncOperatorSecurityReadRepository } from '../services/asyncOperatorSecurityReadRepository';
import { AsyncUserRepository } from '../services/asyncUserRepository';
import { AsyncWorkspaceRepository } from '../services/asyncWorkspaceRepository';
import { hashPassword } from '../services/passwordHash';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const database = new PostgresDatabase({ connectionString, max: 8 });
  try {
    await runPostgresMigrations(database);
    const suffix = Date.now();
    const users = new AsyncUserRepository(database);
    const owner = await users.createUser(
      `operator-domain-${suffix}@example.com`,
      hashPassword('correct horse battery staple'),
      true,
    );
    const workspaces = new AsyncWorkspaceRepository(database);
    const workspace = await workspaces.create(owner.id, `Operator Domain ${suffix}`);
    const otherWorkspace = await workspaces.create(owner.id, `Other Domain ${suffix}`);
    const agents = new AsyncAgentRepository(database, join(tmpdir(), `operator-domain-${suffix}`));
    const agent = await agents.create({ name: `Operator Read ${suffix}` }, workspace.id);
    await agents.create({ name: `Other Operator Read ${suffix}` }, otherWorkspace.id);
    const jobs = new AsyncJobRepository(database);
    const job = await jobs.create({
      type: 'agent.generate',
      workspaceId: workspace.id,
      payload: { agentId: agent.id },
    });
    await database.execute({
      text: `
        INSERT INTO abuse_enforcement_events (
          event_id, rule_key, action, subject_hash, outcome, retry_after_seconds
        ) VALUES ($1, 'operator-smoke', 'deny', $2, 'rate_limited', 45);
      `,
      values: [randomUUID(), `subject-${suffix}`],
    });

    const customerReads = new AsyncOperatorCustomerReadRepository(database);
    const customers = await customerReads.listUsers(workspace.id, 10);
    if (
      customers.length !== 1
      || customers[0]?.userId !== owner.id
      || customers[0]?.workspaceId !== workspace.id
      || 'email' in (customers[0] ?? {})
    ) {
      throw new Error('PostgreSQL operator customer read was not scoped and minimized');
    }
    const runtimeReads = new AsyncOperatorRuntimeReadRepository(database);
    const agentRows = await runtimeReads.listAgents(workspace.id, 10);
    const jobRows = await runtimeReads.listJobs(workspace.id, 10);
    if (
      agentRows.length !== 1
      || agentRows[0]?.id !== agent.id
      || jobRows.length !== 1
      || jobRows[0]?.id !== job.id
      || 'config' in (agentRows[0] ?? {})
      || 'error' in (jobRows[0] ?? {})
    ) {
      throw new Error('PostgreSQL operator runtime read was not scoped and minimized');
    }
    const securityRows = await new AsyncOperatorSecurityReadRepository(database).listAbuseEvents(10);
    const security = securityRows.find((event) => event.ruleKey === 'operator-smoke');
    if (!security || security.retryAfterSeconds !== 45 || 'subjectHash' in security) {
      throw new Error('PostgreSQL operator security read exposed an invalid shape');
    }
    process.stdout.write('postgres operator domain read repositories smoke passed\n');
  } finally {
    await database.close();
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'postgres operator reads smoke failed'}\n`);
  process.exitCode = 1;
});
