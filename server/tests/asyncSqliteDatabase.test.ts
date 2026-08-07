import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAsyncSqliteDatabase } from '../src/db/asyncDatabaseFactory';
import { AsyncSqliteDatabase } from '../src/db/asyncSqlite';

interface ProbeRow {
  enabled: number;
  id: number;
  value: string;
}

function createDatabase(): { database: AsyncSqliteDatabase; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'primalthrum-async-sqlite-'));
  return {
    database: new AsyncSqliteDatabase(join(root, 'database.sqlite')),
    root,
  };
}

test('async SQLite uses parameterized statements and reports schema columns', async () => {
  const { database, root } = createDatabase();
  try {
    await database.execute({
      text: `
        CREATE TABLE probes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          value TEXT NOT NULL,
          enabled INTEGER NOT NULL
        );
      `,
    });
    const hostileValue = "value'); DROP TABLE probes; --";
    const result = await database.execute({
      text: 'INSERT INTO probes (value, enabled) VALUES ($1, $2);',
      values: [hostileValue, true],
    });

    assert.equal(result.rowCount, 1);
    assert.deepEqual(
      await database.query<ProbeRow>({
        text: 'SELECT id, value, enabled FROM probes WHERE value = $1 OR value = $1;',
        values: [hostileValue],
      }),
      [{ id: 1, value: hostileValue, enabled: 1 }],
    );
    assert.deepEqual(
      (await database.columns('probes')).map((column) => column.name),
      ['id', 'value', 'enabled'],
    );
    await assert.rejects(database.columns('probes; DROP TABLE probes'), /table name is invalid/);
  } finally {
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('async SQLite commits and rolls back transaction sessions atomically', async () => {
  const { database, root } = createDatabase();
  try {
    await database.execute({
      text: 'CREATE TABLE counters (id INTEGER PRIMARY KEY, value INTEGER NOT NULL);',
    });
    await database.execute({
      text: 'INSERT INTO counters (id, value) VALUES ($1, $2);',
      values: [1, 0],
    });

    await database.transaction(async (session) => {
      await session.execute({
        text: 'UPDATE counters SET value = value + $1 WHERE id = $2;',
        values: [2, 1],
      });
    });
    await assert.rejects(
      database.transaction(async (session) => {
        await session.execute({
          text: 'UPDATE counters SET value = value + $1 WHERE id = $2;',
          values: [5, 1],
        });
        throw new Error('rollback requested');
      }),
      /rollback requested/,
    );

    assert.deepEqual(
      await database.query<{ value: number }>({
        text: 'SELECT value FROM counters WHERE id = $1;',
        values: [1],
      }),
      [{ value: 2 }],
    );
  } finally {
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('async SQLite rejects missing and unused parameter bindings', async () => {
  const { database, root } = createDatabase();
  try {
    await assert.rejects(
      database.query({ text: 'SELECT $1 AS value;' }),
      /missing parameter \$1/,
    );
    await assert.rejects(
      database.query({ text: 'SELECT 1 AS value;', values: ['unused'] }),
      /unused parameters/,
    );
  } finally {
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('async SQLite factory initializes the existing application schema', async () => {
  const root = mkdtempSync(join(tmpdir(), 'primalthrum-async-sqlite-schema-'));
  const database = createAsyncSqliteDatabase(join(root, 'database.sqlite'));
  try {
    const userColumns = (await database.columns('users')).map((column) => column.name);
    assert.ok(['id', 'workspace_id', 'email', 'password_hash', 'role'].every(
      (columnName) => userColumns.includes(columnName),
    ));
    assert.ok((await database.columns('workspaces')).some((column) => column.name === 'slug'));
    assert.ok((await database.columns('sessions')).some((column) => column.name === 'token_hash'));
  } finally {
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
