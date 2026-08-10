import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  type AsyncDatabaseSession,
  type DatabaseCommandResult,
  type DatabaseStatement,
} from '../src/db/asyncAdapter';
import {
  assertEmptyPostgresRestoreTarget,
  capturePostgresFingerprint,
} from '../src/services/postgres-backup/fingerprint';

class FingerprintSession implements AsyncDatabaseSession {
  constructor(
    private readonly rows: Array<Record<string, unknown>>,
    private readonly includeTable = true,
  ) {}

  async execute(_statement: DatabaseStatement): Promise<DatabaseCommandResult> {
    return { rowCount: 0 };
  }

  async query<T extends object>(statement: DatabaseStatement): Promise<T[]> {
    if (statement.text.includes('FROM schema_migrations')) return [{ id: '001_test' }] as T[];
    if (statement.text.includes('FROM information_schema.tables') || statement.text.includes('FROM pg_class')) {
      return (this.includeTable ? [{ name: 'users' }] : []) as T[];
    }
    if (statement.text.includes('FROM information_schema.columns')) {
      return [
        { table_name: 'users', name: 'id', target_type: 'int4', is_identity: true,
          primary_key_position: 1 },
        { table_name: 'users', name: 'enabled', target_type: 'bool', is_identity: false,
          primary_key_position: null },
        { table_name: 'users', name: 'created_at', target_type: 'timestamptz', is_identity: false,
          primary_key_position: null },
      ] as T[];
    }
    if (statement.text.includes('COUNT(*)')) return [{ count: String(this.rows.length) }] as T[];
    if (statement.text.includes('ORDER BY')) {
      const limit = Number(statement.values?.[0] ?? this.rows.length);
      const offset = Number(statement.values?.[1] ?? 0);
      return structuredClone(this.rows.slice(offset, offset + limit)) as T[];
    }
    throw new Error(`unexpected fingerprint query: ${statement.text}`);
  }
}

test('PostgreSQL backup fingerprint records deterministic per-table rows and digests', async () => {
  const fingerprint = await capturePostgresFingerprint(new FingerprintSession([
    { id: 1, enabled: true, created_at: new Date('2026-08-10T12:00:00Z') },
    { id: 2, enabled: false, created_at: new Date('2026-08-10T12:01:00Z') },
  ]), 1);

  assert.deepEqual(fingerprint.migrationIds, ['001_test']);
  assert.equal(fingerprint.totalRows, 2);
  assert.deepEqual(fingerprint.tables.map((table) => [table.table, table.rows]), [['users', 2]]);
  assert.match(fingerprint.tables[0]?.digest ?? '', /^[a-f0-9]{64}$/);
});

test('PostgreSQL restore target gate requires a database without application tables', async () => {
  await assert.doesNotReject(assertEmptyPostgresRestoreTarget(new FingerprintSession([], false)));
  await assert.rejects(
    assertEmptyPostgresRestoreTarget(new FingerprintSession([], true)),
    /empty dedicated database/,
  );
});
