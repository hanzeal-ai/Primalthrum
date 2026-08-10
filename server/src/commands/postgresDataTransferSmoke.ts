import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { AsyncSqliteDatabase } from '../db/asyncSqlite';
import { createSqliteDatabase } from '../db/databaseFactory';
import { PostgresDatabase } from '../db/postgres';
import { runPostgresMigrations } from '../db/postgresMigrations';
import { inspectDatabaseTransferCatalog } from '../services/database-transfer/catalog';
import { transferSqliteToPostgres } from '../services/database-transfer/service';

interface IdentifierRow {
  id: number;
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  assert.ok(connectionString, 'DATABASE_URL is required');
  const directory = await mkdtemp(join(tmpdir(), 'primalthrum-transfer-'));
  const sourcePath = join(directory, 'source.sqlite');
  createSqliteDatabase(sourcePath);

  const source = new AsyncSqliteDatabase(sourcePath);
  const target = new PostgresDatabase({ connectionString, max: 2 });
  try {
    await source.execute({
      text: `
        INSERT INTO workspaces (id, name, slug, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $4);
      `,
      values: [2, 'Transfer Workspace', 'transfer-workspace', '2026-08-10 12:00:00'],
    });
    await source.execute({
      text: `
        INSERT INTO users (id, workspace_id, email, password_hash, role, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $6);
      `,
      values: [2, 2, 'transfer@example.com', 'hash', 'owner', '2026-08-10 12:01:00'],
    });
    await source.execute({
      text: `
        INSERT INTO agents (
          id, workspace_id, name, slug, description, path, status, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8);
      `,
      values: [2, 2, 'Transfer Agent', 'transfer-agent', 'transfer smoke', '/tmp/agent', 'ready',
        '2026-08-10 12:02:00'],
    });

    await runPostgresMigrations(target);
    const catalog = await inspectDatabaseTransferCatalog(source, target);
    const report = await transferSqliteToPostgres({ source, target, catalog, batchSize: 25 });

    assert.equal(report.status, 'succeeded');
    assert.equal(report.tables.length, catalog.tables.length);
    assert.ok(report.totalRows > 3);
    assert.deepEqual(await target.query({
      text: 'SELECT id FROM users WHERE email = $1;',
      values: ['transfer@example.com'],
    }), [{ id: 2 }]);
    assert.deepEqual(await target.query({
      text: 'SELECT id FROM agents WHERE slug = $1;',
      values: ['transfer-agent'],
    }), [{ id: 2 }]);

    const inserted = await target.query<IdentifierRow>({
      text: `
        INSERT INTO workspaces (name, slug)
        VALUES ($1, $2)
        RETURNING id;
      `,
      values: ['Sequence Check', 'sequence-check'],
    });
    assert.ok((inserted[0]?.id ?? 0) > 2);

    await assert.rejects(
      transferSqliteToPostgres({ source, target, catalog }),
      /contains business data/,
    );
    console.log(`PostgreSQL data transfer smoke passed (${report.totalRows} rows)`);
  } finally {
    await source.close();
    await target.close();
    await rm(directory, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
