import assert from 'node:assert/strict';
import test from 'node:test';
import { type PoolConfig } from 'pg';

import {
  type AsyncDatabaseAdapter,
  type AsyncDatabaseSession,
  type DatabaseCommandResult,
  type DatabaseStatement,
} from '../src/db/asyncAdapter';
import { type DatabaseColumn } from '../src/db/adapter';
import { configureApplicationDatabase } from '../src/services/applicationDatabaseConfiguration';

test('development defaults to SQLite without opening PostgreSQL', async () => {
  let created = false;
  const selection = await configureApplicationDatabase(
    { NODE_ENV: 'development' },
    { createPostgres: () => {
      created = true;
      return new FakeAsyncDatabase();
    } },
  );
  assert.equal(selection.provider, 'sqlite');
  assert.equal(selection.database, undefined);
  assert.equal(created, false);
});

test('production fails closed without DATABASE_URL', async () => {
  await assert.rejects(
    configureApplicationDatabase({ NODE_ENV: 'production' }),
    /DATABASE_URL is required in production/,
  );
});

test('PostgreSQL configuration validates pool bounds and migrates before selection', async () => {
  const database = new FakeAsyncDatabase();
  let receivedConfig: PoolConfig | undefined;
  let migrated = false;
  const selection = await configureApplicationDatabase({
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://user:password@db.internal:5432/primalthrum?sslmode=require',
    DATABASE_POOL_MAX: '32',
    DATABASE_CONNECTION_TIMEOUT_MS: '7000',
    DATABASE_IDLE_TIMEOUT_MS: '45000',
  }, {
    createPostgres: (config) => {
      receivedConfig = config;
      return database;
    },
    migratePostgres: async (target) => {
      assert.equal(target, database);
      migrated = true;
    },
  });
  assert.equal(selection.provider, 'postgres');
  assert.equal(selection.database, database);
  assert.equal(migrated, true);
  assert.equal(receivedConfig?.max, 32);
  assert.equal(receivedConfig?.connectionTimeoutMillis, 7000);
  assert.equal(receivedConfig?.idleTimeoutMillis, 45000);
});

test('invalid PostgreSQL settings fail before a pool is opened', async () => {
  let created = false;
  const dependencies = {
    createPostgres: () => {
      created = true;
      return new FakeAsyncDatabase();
    },
  };
  await assert.rejects(
    configureApplicationDatabase({ DATABASE_URL: 'https://db.example.com/primalthrum' }, dependencies),
    /valid PostgreSQL connection string/,
  );
  await assert.rejects(
    configureApplicationDatabase({
      DATABASE_URL: 'postgresql://db.example.com/primalthrum',
      DATABASE_POOL_MAX: '0',
    }, dependencies),
    /DATABASE_POOL_MAX is invalid/,
  );
  assert.equal(created, false);
});

test('migration failure closes the PostgreSQL pool and prevents selection', async () => {
  const database = new FakeAsyncDatabase();
  await assert.rejects(
    configureApplicationDatabase({
      DATABASE_URL: 'postgresql://db.example.com/primalthrum',
    }, {
      createPostgres: () => database,
      migratePostgres: async () => {
        throw new Error('migration failed');
      },
    }),
    /migration failed/,
  );
  assert.equal(database.closed, true);
});

class FakeAsyncDatabase implements AsyncDatabaseAdapter {
  readonly dialect = 'postgres' as const;
  closed = false;

  async execute(_statement: DatabaseStatement): Promise<DatabaseCommandResult> {
    return { rowCount: 0 };
  }

  async query<T extends object>(_statement: DatabaseStatement): Promise<T[]> {
    return [];
  }

  async columns(_tableName: string): Promise<DatabaseColumn[]> {
    return [];
  }

  async transaction<T>(operation: (session: AsyncDatabaseSession) => Promise<T>): Promise<T> {
    return operation(this);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
