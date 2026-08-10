import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  type AsyncDatabaseAdapter,
  type AsyncDatabaseSession,
  type DatabaseCommandResult,
  type DatabaseStatement,
} from '../src/db/asyncAdapter';
import { POSTGRES_MIGRATIONS } from '../src/db/postgresMigrations';
import {
  assertTransferTargetMigrationState,
  inspectDatabaseTransferCatalog,
} from '../src/services/database-transfer/catalog';

interface CatalogFixture {
  tables: string[];
  columns: Record<string, Array<{ name: string; pk: number; targetType: string; identity?: boolean }>>;
  foreignKeys?: Array<{ table_name: string; referenced_table: string }>;
  migrationIds?: string[];
  migrationTableExists?: boolean;
}

class CatalogDatabase implements AsyncDatabaseAdapter {
  constructor(
    readonly dialect: 'sqlite' | 'postgres',
    private readonly fixture: CatalogFixture,
  ) {}

  async execute(_statement: DatabaseStatement): Promise<DatabaseCommandResult> {
    return { rowCount: 0 };
  }

  async query<T extends object>(statement: DatabaseStatement): Promise<T[]> {
    if (statement.text.includes('to_regclass')) {
      const exists = this.fixture.migrationTableExists ?? true;
      return [{ name: exists ? 'schema_migrations' : null }] as T[];
    }
    if (statement.text.includes('FROM schema_migrations')) {
      const ids = this.fixture.migrationIds ?? POSTGRES_MIGRATIONS.map((migration) => migration.id);
      return ids.map((id) => ({ id })) as T[];
    }
    if (statement.text.includes('FROM sqlite_schema')) {
      return this.fixture.tables.map((name) => ({ name })) as T[];
    }
    if (statement.text.startsWith('PRAGMA table_info')) {
      const table = /"([a-zA-Z0-9_]+)"/.exec(statement.text)?.[1] ?? '';
      return (this.fixture.columns[table] ?? []).map((column) => ({
        name: column.name,
        pk: column.pk,
      })) as T[];
    }
    if (statement.text.includes('FROM information_schema.tables')) {
      return this.fixture.tables.map((name) => ({ name })) as T[];
    }
    if (statement.text.includes('FROM information_schema.columns')) {
      return this.fixture.tables.flatMap((table) => (
        (this.fixture.columns[table] ?? []).map((column) => ({
          table_name: table,
          name: column.name,
          target_type: column.targetType,
          is_identity: column.identity ?? false,
          primary_key_position: column.pk || null,
        }))
      )) as T[];
    }
    if (statement.text.includes('FROM information_schema.table_constraints')) {
      return (this.fixture.foreignKeys ?? []) as T[];
    }
    throw new Error(`unexpected catalog query: ${statement.text}`);
  }

  async columns(): Promise<[]> {
    return [];
  }

  transaction<T>(operation: (session: AsyncDatabaseSession) => Promise<T>): Promise<T> {
    return operation(this);
  }

  async close(): Promise<void> {}
}

const sourceFixture: CatalogFixture = {
  tables: ['children', 'parents'],
  columns: {
    children: [
      { name: 'id', pk: 1, targetType: 'int4', identity: true },
      { name: 'parent_id', pk: 0, targetType: 'int4' },
    ],
    parents: [
      { name: 'id', pk: 1, targetType: 'int4', identity: true },
      { name: 'name', pk: 0, targetType: 'text' },
    ],
  },
  foreignKeys: [{ table_name: 'children', referenced_table: 'parents' }],
};

test('database transfer catalog proves schema parity and orders foreign-key parents first', async () => {
  const source = new CatalogDatabase('sqlite', sourceFixture);
  const target = new CatalogDatabase('postgres', sourceFixture);

  const catalog = await inspectDatabaseTransferCatalog(source, target);

  assert.deepEqual(catalog.migrationIds, POSTGRES_MIGRATIONS.map((migration) => migration.id));
  assert.deepEqual(catalog.tables.map((table) => table.name), ['parents', 'children']);
  assert.deepEqual(catalog.tables[1]?.dependencies, ['parents']);
  assert.deepEqual(catalog.tables[0]?.primaryKey, ['id']);
});

test('database transfer catalog rejects different table sets before copying data', async () => {
  const source = new CatalogDatabase('sqlite', sourceFixture);
  const target = new CatalogDatabase('postgres', {
    ...sourceFixture,
    tables: ['children', 'parents', 'unexpected'],
    columns: { ...sourceFixture.columns, unexpected: [{ name: 'id', pk: 1, targetType: 'int4' }] },
  });

  await assert.rejects(
    inspectDatabaseTransferCatalog(source, target),
    /table sets do not match/,
  );
});

test('database transfer target gate accepts empty databases and rejects partial migration state', async () => {
  const empty = new CatalogDatabase('postgres', {
    tables: [],
    columns: {},
    migrationTableExists: false,
  });
  await assert.doesNotReject(assertTransferTargetMigrationState(empty));

  const unrelated = new CatalogDatabase('postgres', {
    tables: ['legacy_data'],
    columns: {},
    migrationTableExists: false,
  });
  await assert.rejects(
    assertTransferTargetMigrationState(unrelated),
    /not an empty dedicated database/,
  );

  const partial = new CatalogDatabase('postgres', {
    tables: ['workspaces'],
    columns: sourceFixture.columns,
    migrationIds: POSTGRES_MIGRATIONS.slice(0, -1).map((migration) => migration.id),
  });
  await assert.rejects(
    assertTransferTargetMigrationState(partial),
    /partial or outdated migration state/,
  );
});
