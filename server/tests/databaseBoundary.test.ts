import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { sqlValue } from '../src/db/sql';
import { SqliteDatabase } from '../src/db/sqlite';

test('service persistence depends on the database contract rather than SQLite', () => {
  const servicesDir = join(process.cwd(), 'src', 'services');
  const concreteImports = readdirSync(servicesDir)
    .filter((filename) => filename.endsWith('.ts'))
    .filter((filename) => readFileSync(join(servicesDir, filename), 'utf8').includes("../db/sqlite"));

  assert.deepEqual(concreteImports, []);
});

test('SQLite implements dialect metadata and safe schema introspection', () => {
  const root = mkdtempSync(join(tmpdir(), 'primalthrum-database-boundary-'));
  try {
    const db = new SqliteDatabase(join(root, 'platform.sqlite'));
    db.run('CREATE TABLE boundary_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL);');

    assert.equal(db.dialect, 'sqlite');
    assert.deepEqual(db.columns('boundary_probe').map((column) => column.name), ['id', 'value']);
    assert.throws(() => db.columns('boundary_probe; DROP TABLE boundary_probe;'), /table name is invalid/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('shared SQL values preserve the existing literal contract', () => {
  assert.equal(sqlValue(null), 'NULL');
  assert.equal(sqlValue(17), '17');
  assert.equal(sqlValue(true), '1');
  assert.equal(sqlValue(false), '0');
  assert.equal(sqlValue("owner's workspace"), "'owner''s workspace'");
});
