import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type DatabaseParameter } from '../src/db/asyncAdapter';
import {
  PostgresDatabase,
  type PostgresPoolFacade,
  type PostgresPoolFactory,
} from '../src/db/postgres';

interface RecordedQuery {
  text: string;
  values?: DatabaseParameter[];
}

function fakePool(options: { failText?: string } = {}): {
  factory: PostgresPoolFactory;
  poolQueries: RecordedQuery[];
  transactionQueries: RecordedQuery[];
  state: { ended: boolean; released: boolean };
} {
  const poolQueries: RecordedQuery[] = [];
  const transactionQueries: RecordedQuery[] = [];
  const state = { ended: false, released: false };
  const query = async <T extends object>(
    target: RecordedQuery[],
    text: string,
    values?: DatabaseParameter[],
  ) => {
    target.push({ text, values });
    if (options.failText === text) throw new Error('forced query failure');
    const rows = text.includes('information_schema.columns')
      ? [{ name: 'id' }, { name: 'value' }]
      : text.includes('SELECT') ? [{ value: 'result' }] : [];
    return { rows: rows as T[], rowCount: text.includes('INSERT') ? 1 : rows.length };
  };
  const pool: PostgresPoolFacade = {
    query: (text, values) => query(poolQueries, text, values),
    connect: async () => ({
      query: (text, values) => query(transactionQueries, text, values),
      release: () => {
        state.released = true;
      },
    }),
    end: async () => {
      state.ended = true;
    },
  };
  return { factory: () => pool, poolQueries, transactionQueries, state };
}

test('PostgreSQL adapter preserves parameter values outside SQL text', async () => {
  const fake = fakePool();
  const database = new PostgresDatabase({}, fake.factory);
  const value = "owner's workspace";

  const result = await database.execute({
    text: 'INSERT INTO workspaces (name) VALUES ($1);',
    values: [value],
  });

  assert.equal(result.rowCount, 1);
  assert.deepEqual(fake.poolQueries, [{
    text: 'INSERT INTO workspaces (name) VALUES ($1);',
    values: [value],
  }]);
});

test('PostgreSQL adapter commits successful transactions and releases clients', async () => {
  const fake = fakePool();
  const database = new PostgresDatabase({}, fake.factory);

  const result = await database.transaction(async (transaction) => {
    await transaction.execute({ text: 'INSERT INTO jobs (status) VALUES ($1);', values: ['pending'] });
    return 'committed';
  });

  assert.equal(result, 'committed');
  assert.deepEqual(fake.transactionQueries.map((entry) => entry.text), [
    'BEGIN',
    'INSERT INTO jobs (status) VALUES ($1);',
    'COMMIT',
  ]);
  assert.equal(fake.state.released, true);
});

test('PostgreSQL adapter rolls back failed transactions and preserves the error', async () => {
  const fake = fakePool({ failText: 'SELECT broken;' });
  const database = new PostgresDatabase({}, fake.factory);

  await assert.rejects(
    database.transaction(async (transaction) => {
      await transaction.query({ text: 'SELECT broken;' });
    }),
    /forced query failure/,
  );

  assert.deepEqual(fake.transactionQueries.map((entry) => entry.text), [
    'BEGIN',
    'SELECT broken;',
    'ROLLBACK',
  ]);
  assert.equal(fake.state.released, true);
});

test('PostgreSQL adapter parameterizes schema introspection and closes the pool', async () => {
  const fake = fakePool();
  const database = new PostgresDatabase({}, fake.factory);

  assert.deepEqual(await database.columns("users' unsafe"), [{ name: 'id' }, { name: 'value' }]);
  assert.deepEqual(fake.poolQueries[0]?.values, ["users' unsafe"]);

  await database.close();
  assert.equal(fake.state.ended, true);
});
