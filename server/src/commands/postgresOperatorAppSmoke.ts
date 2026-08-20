import { mkdtempSync, rmSync } from 'node:fs';
import { type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../app';
import { type DatabaseAdapter, type DatabaseColumn } from '../db/adapter';
import { createSqliteDatabase } from '../db/databaseFactory';
import { PostgresDatabase } from '../db/postgres';
import { runPostgresMigrations } from '../db/postgresMigrations';
import { AsyncAgentRepository } from '../services/asyncAgentRepository';
import { AsyncOperatorIdentityRepository } from '../services/asyncOperatorIdentityRepository';
import { AsyncOperatorIncidentRepository } from '../services/asyncOperatorIncidentRepository';
import { AsyncUserRepository } from '../services/asyncUserRepository';
import { hashPassword } from '../services/passwordHash';

const PASSWORD = 'postgres operator smoke password';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const rootDir = mkdtempSync(join(tmpdir(), 'primalthrum-postgres-operator-app-'));
  const postgres = new PostgresDatabase({ connectionString, max: 12 });
  const fallback = new TrackingDatabase(createSqliteDatabase(join(rootDir, 'fallback.sqlite')));
  let server: Server | undefined;
  try {
    await runPostgresMigrations(postgres);
    const suffix = `${Date.now()}-${process.pid}`;
    const identities = new AsyncOperatorIdentityRepository(postgres);
    const root = await ensureRoot(postgres, identities, suffix);
    await identities.updatePassword(root.id, hashPassword(PASSWORD));

    const markerEmail = `operator-app-marker-${suffix}@example.com`;
    const markerUser = await new AsyncUserRepository(postgres).createUser(
      markerEmail,
      hashPassword(PASSWORD),
      true,
    );
    await postgres.execute({
      text: `
        INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
        VALUES (1, $1, 'member', 'active');
      `,
      values: [markerUser.id],
    });
    const markerAgent = await new AsyncAgentRepository(postgres, join(rootDir, 'agents')).create({
      name: `Operator App Marker ${suffix}`,
      description: 'PostgreSQL Operator composition marker',
      memoryProvider: 'null',
      cacheProvider: 'memory',
      ragProvider: 'none',
      enabledTools: [],
      enabledSkills: [],
    }, 1);

    const app = createApp({
      database: fallback,
      identityDatabase: postgres,
      runtimeDatabase: postgres,
      generatedAgentsDir: join(rootDir, 'generated-agents'),
      documentStorageDir: join(rootDir, 'documents'),
      logger: { log: () => undefined },
      startBackgroundSchedulers: false,
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server?.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('operator smoke server did not start');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    fallback.arm();

    const login = await request(baseUrl, '/api/operator/auth/login', 'POST', {
      email: root.email,
      password: PASSWORD,
    });
    assertStatus(login, 200, 'operator login');
    const token = (await login.json() as { session: { token: string } }).session.token;
    const headers = { authorization: `Bearer ${token}` };

    for (const path of [
      '/api/operator/overview',
      '/api/operator/workspaces',
      '/api/operator/customer-users',
      '/api/operator/subscriptions',
      '/api/operator/usage',
      '/api/operator/payments',
      '/api/operator/agents',
      '/api/operator/jobs',
      '/api/operator/abuse-events',
      '/api/operator/feature-flags',
      '/api/operator/incidents',
      '/api/operator/legal-holds',
      '/api/operator/operators',
      '/api/operator/support-grants',
      '/api/operator/audit',
    ]) {
      assertStatus(await request(baseUrl, path, 'GET', undefined, headers), 200, path);
    }

    const customers = await request(baseUrl, '/api/operator/customer-users', 'GET', undefined, headers);
    const customerRows = await customers.json() as Array<{ userId: number }>;
    if (!customerRows.some((row) => row.userId === markerUser.id)) {
      throw new Error('Operator customer reads did not use PostgreSQL');
    }
    const agents = await request(baseUrl, '/api/operator/agents', 'GET', undefined, headers);
    const agentRows = await agents.json() as Array<{ id: number }>;
    if (!agentRows.some((row) => row.id === markerAgent.id)) {
      throw new Error('Operator runtime reads did not use PostgreSQL');
    }

    const flagResponse = await request(baseUrl, '/api/operator/feature-flags', 'POST', {
      key: `operator.smoke.${suffix}`,
      description: 'PostgreSQL Operator application composition smoke flag.',
      enabled: true,
      killSwitch: false,
      rolloutPercentage: 100,
    }, headers);
    assertStatus(flagResponse, 201, 'feature flag creation');

    const incidentResponse = await request(baseUrl, '/api/operator/incidents', 'POST', {
      title: 'PostgreSQL Operator application smoke incident',
      severity: 'sev2',
      impactScope: 'platform',
      workspaceId: null,
      summary: 'Verify global Operator composition and concurrent incident revisions.',
      startedAt: new Date(Date.now() - 1_000).toISOString(),
      ownerOperatorId: root.id,
    }, headers);
    assertStatus(incidentResponse, 201, 'incident creation');
    const incident = await incidentResponse.json() as { id: number; revision: number };
    await verifyIncidentConcurrency(postgres, incident.id, incident.revision, root.id);

    const incidentRead = await request(
      baseUrl,
      `/api/operator/incidents/${incident.id}`,
      'GET',
      undefined,
      headers,
    );
    assertStatus(incidentRead, 200, 'incident read');
    const detail = await incidentRead.json() as { revision: number; eventCount: number };
    if (detail.revision !== 2 || detail.eventCount !== 2) {
      throw new Error('PostgreSQL incident revision evidence is inconsistent');
    }

    if (fallback.statements.length > 0) {
      throw new Error(`Operator flow leaked into SQLite: ${fallback.statements[0]}`);
    }
    process.stdout.write('postgres Operator application composition smoke passed\n');
  } finally {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    fallback.close();
    await postgres.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
}

async function ensureRoot(
  database: PostgresDatabase,
  identities: AsyncOperatorIdentityRepository,
  suffix: string,
): Promise<{ id: number; email: string }> {
  if (await identities.needsSetup()) {
    return identities.createInitial(
      `operator-app-root-${suffix}@example.com`,
      hashPassword(PASSWORD),
    );
  }
  const rows = await database.query<{ id: number }>({
    text: 'SELECT id FROM operator_users WHERE bootstrap_root = TRUE LIMIT 1;',
  });
  const root = rows[0] ? await identities.findById(Number(rows[0].id)) : null;
  if (!root) throw new Error('PostgreSQL root operator could not be loaded');
  return root;
}

async function verifyIncidentConcurrency(
  database: PostgresDatabase,
  incidentId: number,
  revision: number,
  operatorUserId: number,
): Promise<void> {
  const first = new AsyncOperatorIncidentRepository(database);
  const second = new AsyncOperatorIncidentRepository(database);
  const update = (repository: AsyncOperatorIncidentRepository, title: string) => repository.update(
    incidentId,
    {
      title,
      severity: 'sev1',
      status: 'identified',
      impactScope: 'platform',
      workspaceId: null,
      summary: 'Concurrent PostgreSQL incident update must have exactly one winner.',
      ownerOperatorId: operatorUserId,
      expectedRevision: revision,
      operatorUserId,
    },
  );
  const results = await Promise.allSettled([
    update(first, 'PostgreSQL incident update first contender'),
    update(second, 'PostgreSQL incident update second contender'),
  ]);
  if (results.filter((result) => result.status === 'fulfilled').length !== 1) {
    throw new Error('PostgreSQL incident revision was not single-winner');
  }
}

async function request(
  baseUrl: string,
  path: string,
  method: string,
  body?: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...headers,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function assertStatus(response: Response, expected: number, operation: string): void {
  if (response.status !== expected) {
    throw new Error(`${operation} returned ${response.status}, expected ${expected}`);
  }
}

class TrackingDatabase implements DatabaseAdapter {
  readonly dialect = 'sqlite' as const;
  readonly statements: string[] = [];
  private tracking = false;

  constructor(private readonly database: DatabaseAdapter) {}

  arm(): void {
    this.tracking = true;
  }

  columns(tableName: string): DatabaseColumn[] {
    if (this.tracking) this.statements.push(`columns:${tableName}`);
    return this.database.columns(tableName);
  }

  run(sql: string): void {
    if (this.tracking) this.statements.push(sql);
    this.database.run(sql);
  }

  query<T extends object>(sql: string): T[] {
    if (this.tracking) this.statements.push(sql);
    return this.database.query<T>(sql);
  }

  close(): void {
    const close = (this.database as DatabaseAdapter & { close?: () => void }).close;
    close?.call(this.database);
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'postgres Operator app smoke failed'}\n`);
  process.exitCode = 1;
});
