import { randomUUID } from 'node:crypto';

import { PostgresDatabase } from '../db/postgres';
import { runPostgresMigrations } from '../db/postgresMigrations';
import { AsyncProviderConfigRepository } from '../services/asyncProviderConfigRepository';
import { AsyncSecretVault } from '../services/asyncSecretVault';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');

  const database = new PostgresDatabase({ connectionString, max: 4 });
  const marker = randomUUID();
  const secrets = new AsyncSecretVault(database);
  const providers = new AsyncProviderConfigRepository(database, secrets);
  let workspaceId: number | null = null;
  try {
    await runPostgresMigrations(database);
    const workspaces = await database.query<{ id: number }>({
      text: `
        INSERT INTO workspaces (name, slug) VALUES ($1, $2) RETURNING id;
      `,
      values: [`Provider ${marker}`, `provider-${marker}`],
    });
    workspaceId = Number(workspaces[0]?.id);
    if (!Number.isSafeInteger(workspaceId) || workspaceId <= 0) {
      throw new Error('PostgreSQL Provider smoke workspace was not created');
    }
    const provider = await providers.create({
      name: `OpenAI ${marker}`,
      type: 'llm',
      config: { provider: 'openai', model: 'gpt-commercial' },
      secret: "postgres-secret-'parameter",
    }, workspaceId);
    const before = Number((await database.query<{ count: number | string }>({
      text: 'SELECT COUNT(*) AS count FROM secrets WHERE workspace_id = $1;',
      values: [workspaceId],
    }))[0]?.count ?? 0);
    let duplicateRejected = false;
    try {
      await providers.create({
        name: provider.name,
        type: 'llm',
        secret: 'must-rollback',
      }, workspaceId);
    } catch (error) {
      if (postgresErrorCode(error) !== '23505') throw error;
      duplicateRejected = true;
    }
    if (!duplicateRejected) throw new Error('duplicate PostgreSQL provider unexpectedly succeeded');
    const after = Number((await database.query<{ count: number | string }>({
      text: 'SELECT COUNT(*) AS count FROM secrets WHERE workspace_id = $1;',
      values: [workspaceId],
    }))[0]?.count ?? 0);
    const ciphertext = await database.query<{ ciphertext: string }>({
      text: 'SELECT ciphertext FROM secrets WHERE secret_ref = $1;',
      values: [provider.secretRef],
    });
    if (
      before !== 1
      || after !== before
      || await secrets.read(provider.secretRef, workspaceId) !== "postgres-secret-'parameter"
      || ciphertext[0]?.ciphertext === "postgres-secret-'parameter"
    ) {
      throw new Error('PostgreSQL Provider secret transaction is inconsistent');
    }
    await assertTenantIsolation(secrets, provider.secretRef, workspaceId + 1000);
    process.stdout.write('postgres ProviderConfig repository smoke passed\n');
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

function postgresErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

async function assertTenantIsolation(
  secrets: AsyncSecretVault,
  secretRef: string,
  workspaceId: number,
): Promise<void> {
  try {
    await secrets.read(secretRef, workspaceId);
  } catch (error) {
    if (error instanceof Error && error.message === 'provider secret not found') return;
    throw error;
  }
  throw new Error('PostgreSQL Provider secret crossed the Workspace boundary');
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'postgres Provider smoke failed'}\n`);
  process.exitCode = 1;
});
