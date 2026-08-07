import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  type AsyncDatabaseAdapter,
  type AsyncDatabaseSession,
  type DatabaseStatement,
} from '../src/db/asyncAdapter';
import {
  type PostgresMigration,
  runPostgresMigrations,
} from '../src/db/postgresMigrations';

function migrationDatabase(appliedIds: string[] = []): {
  database: AsyncDatabaseAdapter;
  statements: DatabaseStatement[];
} {
  const statements: DatabaseStatement[] = [];
  const session: AsyncDatabaseSession = {
    execute: async (statement) => {
      statements.push(statement);
      return { rowCount: 0 };
    },
    query: async <T extends object>(statement: DatabaseStatement) => {
      statements.push(statement);
      return appliedIds.map((id) => ({ id })) as T[];
    },
  };
  return {
    database: {
      ...session,
      dialect: 'postgres',
      columns: async () => [],
      transaction: async (operation) => operation(session),
      close: async () => undefined,
    },
    statements,
  };
}

test('PostgreSQL migrations run in order behind an advisory transaction lock', async () => {
  const fixture = migrationDatabase();
  const applied: string[] = [];
  const migrations: PostgresMigration[] = [
    { id: '001_first', up: async () => { applied.push('001_first'); } },
    { id: '002_second', up: async () => { applied.push('002_second'); } },
  ];

  await runPostgresMigrations(fixture.database, migrations);

  assert.deepEqual(applied, ['001_first', '002_second']);
  assert.match(fixture.statements[0]?.text ?? '', /pg_advisory_xact_lock/);
  assert.deepEqual(
    fixture.statements.filter((statement) => statement.text.includes('INSERT INTO schema_migrations'))
      .map((statement) => statement.values?.[0]),
    ['001_first', '002_second'],
  );
});

test('PostgreSQL migrations skip immutable IDs already recorded', async () => {
  const fixture = migrationDatabase(['001_first']);
  let executions = 0;

  await runPostgresMigrations(fixture.database, [
    { id: '001_first', up: async () => { executions += 1; } },
  ]);

  assert.equal(executions, 0);
});

test('PostgreSQL migrations reject malformed, duplicate, and unordered IDs', async () => {
  const fixture = migrationDatabase();
  const migration = (id: string): PostgresMigration => ({ id, up: async () => undefined });

  await assert.rejects(runPostgresMigrations(fixture.database, [migration('bad')]), /invalid/);
  await assert.rejects(
    runPostgresMigrations(fixture.database, [migration('001_first'), migration('001_first')]),
    /duplicated or out of order/,
  );
  await assert.rejects(
    runPostgresMigrations(fixture.database, [migration('002_second'), migration('001_first')]),
    /duplicated or out of order/,
  );
});
