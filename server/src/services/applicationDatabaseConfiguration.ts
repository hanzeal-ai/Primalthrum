import { type PoolConfig } from 'pg';

import { type AsyncDatabaseAdapter } from '../db/asyncAdapter';
import { PostgresDatabase } from '../db/postgres';
import { runPostgresMigrations } from '../db/postgresMigrations';

export type ApplicationDatabaseProvider = 'sqlite' | 'postgres';

export interface ApplicationDatabaseSelection {
  provider: ApplicationDatabaseProvider;
  database?: AsyncDatabaseAdapter;
}

interface ApplicationDatabaseDependencies {
  createPostgres?: (config: PoolConfig) => AsyncDatabaseAdapter;
  migratePostgres?: (database: AsyncDatabaseAdapter) => Promise<void>;
}

export async function configureApplicationDatabase(
  environment: NodeJS.ProcessEnv,
  dependencies: ApplicationDatabaseDependencies = {},
): Promise<ApplicationDatabaseSelection> {
  const connectionString = environment.DATABASE_URL?.trim();
  if (!connectionString) {
    if (environment.NODE_ENV === 'production') {
      throw new Error('DATABASE_URL is required in production');
    }
    return { provider: 'sqlite' };
  }
  assertPostgresConnectionString(connectionString);
  const createPostgres = dependencies.createPostgres
    ?? ((config: PoolConfig) => new PostgresDatabase(config));
  const migratePostgres = dependencies.migratePostgres ?? runPostgresMigrations;
  const database = createPostgres({
    connectionString,
    max: boundedInteger(environment.DATABASE_POOL_MAX, 20, 1, 100, 'DATABASE_POOL_MAX'),
    connectionTimeoutMillis: boundedInteger(
      environment.DATABASE_CONNECTION_TIMEOUT_MS,
      5_000,
      100,
      120_000,
      'DATABASE_CONNECTION_TIMEOUT_MS',
    ),
    idleTimeoutMillis: boundedInteger(
      environment.DATABASE_IDLE_TIMEOUT_MS,
      30_000,
      1_000,
      600_000,
      'DATABASE_IDLE_TIMEOUT_MS',
    ),
  });
  try {
    await migratePostgres(database);
    return { provider: 'postgres', database };
  } catch (error) {
    await database.close().catch(() => undefined);
    throw error;
  }
}

function assertPostgresConnectionString(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL connection string');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error('DATABASE_URL must be a valid PostgreSQL connection string');
  }
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} is invalid`);
  }
  return parsed;
}
