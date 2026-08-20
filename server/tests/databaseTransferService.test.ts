import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  type AsyncDatabaseAdapter,
  type AsyncDatabaseSession,
  type DatabaseCommandResult,
  type DatabaseStatement,
} from '../src/db/asyncAdapter';
import { transferSqliteToPostgres } from '../src/services/database-transfer/service';
import {
  type DatabaseTransferCatalog,
  type TransferTable,
} from '../src/services/database-transfer/types';
import { assertFreshTransferTarget } from '../src/services/database-transfer/preflight';

type Row = Record<string, unknown>;

function cloneRows(rows: Map<string, Row[]>): Map<string, Row[]> {
  return new Map([...rows].map(([table, entries]) => [table, structuredClone(entries)]));
}

function tableFromSql(text: string): string {
  const table = /(?:FROM|INTO)\s+"([a-zA-Z0-9_]+)"/i.exec(text)?.[1];
  if (!table) throw new Error(`test database cannot identify table: ${text}`);
  return table;
}

class MemoryTransferDatabase implements AsyncDatabaseAdapter {
  readonly events: string[] = [];

  constructor(
    readonly dialect: 'sqlite' | 'postgres',
    private rows: Map<string, Row[]>,
    private readonly tables: Map<string, TransferTable>,
    private readonly corruptTable?: string,
  ) {}

  async execute(statement: DatabaseStatement): Promise<DatabaseCommandResult> {
    const normalized = statement.text.trim();
    this.events.push(normalized);
    if (normalized.startsWith('SET LOCAL') || normalized.startsWith('LOCK TABLE')) {
      return { rowCount: 0 };
    }
    if (!normalized.startsWith('INSERT INTO')) throw new Error(`unexpected execute: ${normalized}`);

    const tableName = tableFromSql(normalized);
    const table = this.tables.get(tableName);
    if (!table) throw new Error(`unknown table ${tableName}`);
    const rawColumns = /INSERT INTO\s+"[^"]+"\s+\(([^)]+)\)/i.exec(normalized)?.[1] ?? '';
    const columns = [...rawColumns.matchAll(/"([a-zA-Z0-9_]+)"/g)].map((match) => match[1] ?? '');
    const values = statement.values ?? [];
    const targetRows = this.rows.get(tableName) ?? [];
    for (let offset = 0; offset < values.length; offset += columns.length) {
      const incoming = Object.fromEntries(columns.map((column, index) => [
        column,
        values[offset + index] ?? null,
      ]));
      const existing = targetRows.find((row) => table.primaryKey.every(
        (key) => row[key] === incoming[key],
      ));
      if (existing) Object.assign(existing, incoming);
      else targetRows.push(incoming);
    }
    if (this.corruptTable === tableName && targetRows[0]) targetRows[0].name = 'corrupted';
    this.rows.set(tableName, targetRows);
    return { rowCount: values.length / columns.length };
  }

  async query<T extends object>(statement: DatabaseStatement): Promise<T[]> {
    const normalized = statement.text.trim();
    this.events.push(normalized);
    if (normalized.startsWith('SELECT setval')) return [{ value: 1 }] as T[];
    const tableName = tableFromSql(normalized);
    const tableRows = this.rows.get(tableName) ?? [];
    if (normalized.startsWith('SELECT COUNT(*)')) {
      const count = this.dialect === 'postgres' ? String(tableRows.length) : tableRows.length;
      return [{ count }] as T[];
    }
    if (normalized.includes(' WHERE ')) {
      const predicates = [...normalized.matchAll(/"([a-zA-Z0-9_]+)"\s*=\s*\$(\d+)/g)];
      const match = tableRows.find((row) => predicates.every((predicate) => (
        row[predicate[1] ?? ''] === statement.values?.[Number(predicate[2]) - 1]
      )));
      return (match ? [structuredClone(match)] : []) as T[];
    }
    if (normalized.includes(' ORDER BY ')) {
      const orderClause = normalized.split(' ORDER BY ')[1]?.split(' LIMIT ')[0] ?? '';
      const keys = [...orderClause.matchAll(/"([a-zA-Z0-9_]+)"/g)].map((match) => match[1] ?? '');
      const ordered = structuredClone(tableRows).sort((left, right) => {
        for (const key of keys) {
          const comparison = String(left[key]).localeCompare(String(right[key]), undefined, { numeric: true });
          if (comparison !== 0) return comparison;
        }
        return 0;
      });
      const limit = Number(statement.values?.[0] ?? ordered.length);
      const offset = Number(statement.values?.[1] ?? 0);
      return ordered.slice(offset, offset + limit) as T[];
    }
    throw new Error(`unexpected query: ${normalized}`);
  }

  async columns(): Promise<[]> {
    return [];
  }

  async transaction<T>(operation: (session: AsyncDatabaseSession) => Promise<T>): Promise<T> {
    const before = cloneRows(this.rows);
    try {
      return await operation(this);
    } catch (error) {
      this.rows = before;
      throw error;
    }
  }

  async close(): Promise<void> {}

  table(name: string): Row[] {
    return structuredClone(this.rows.get(name) ?? []);
  }
}

const workspaces: TransferTable = {
  name: 'workspaces',
  columns: [
    { name: 'id', targetType: 'int4', primaryKeyPosition: 1, identity: true },
    { name: 'name', targetType: 'text', primaryKeyPosition: 0, identity: false },
    { name: 'slug', targetType: 'text', primaryKeyPosition: 0, identity: false },
    { name: 'created_at', targetType: 'timestamptz', primaryKeyPosition: 0, identity: false },
  ],
  primaryKey: ['id'],
  dependencies: [],
};
const users: TransferTable = {
  name: 'users',
  columns: [
    { name: 'id', targetType: 'int4', primaryKeyPosition: 1, identity: true },
    { name: 'workspace_id', targetType: 'int4', primaryKeyPosition: 0, identity: false },
    { name: 'active', targetType: 'bool', primaryKeyPosition: 0, identity: false },
  ],
  primaryKey: ['id'],
  dependencies: ['workspaces'],
};
const catalog: DatabaseTransferCatalog = {
  migrationIds: ['001_test'],
  tables: [workspaces, users],
};
const tableMap = new Map(catalog.tables.map((table) => [table.name, table]));

const meterPrices: TransferTable = {
  name: 'meter_prices',
  columns: [
    { name: 'id', targetType: 'int4', primaryKeyPosition: 1, identity: true },
    { name: 'pricing_version_key', targetType: 'text', primaryKeyPosition: 0, identity: false },
    { name: 'meter', targetType: 'text', primaryKeyPosition: 0, identity: false },
    { name: 'provider', targetType: 'text', primaryKeyPosition: 0, identity: false },
    { name: 'model', targetType: 'text', primaryKeyPosition: 0, identity: false },
  ],
  primaryKey: ['id'],
  dependencies: [],
};
const meterRows = [
  'api.runs', 'embedding.tokens', 'file.storage_bytes', 'hosted.runs', 'llm.input_tokens',
  'llm.output_tokens', 'rag.retrievals', 'rag.storage_bytes', 'speech.synthesis_characters',
  'speech.transcription_seconds', 'tool.calls',
].map((meter, index) => ({
  id: index + 1,
  pricing_version_key: '2026-08-default',
  meter,
  provider: '*',
  model: '*',
}));

function sourceDatabase(): MemoryTransferDatabase {
  return new MemoryTransferDatabase('sqlite', new Map([
    ['workspaces', [{ id: 1, name: 'Source', slug: 'local', created_at: '2026-08-10 12:00:00' }]],
    ['users', [{ id: 7, workspace_id: 1, active: 1 }]],
  ]), tableMap);
}

test('database transfer overwrites permitted bootstrap rows and reconciles every table', async () => {
  const source = sourceDatabase();
  const target = new MemoryTransferDatabase('postgres', new Map([
    ['workspaces', [{ id: 1, name: 'Bootstrap', slug: 'local', created_at: new Date('2026-08-11T00:00:00Z') }]],
    ['users', []],
  ]), tableMap);
  const timestamps = [new Date('2026-08-10T13:00:00Z'), new Date('2026-08-10T13:01:00Z')];

  const report = await transferSqliteToPostgres({
    source,
    target,
    catalog,
    batchSize: 1,
    now: () => timestamps.shift() ?? new Date('2026-08-10T13:01:00Z'),
  });

  assert.equal(report.totalRows, 2);
  assert.deepEqual(report.tables.map((entry) => [entry.table, entry.rows]), [
    ['workspaces', 1],
    ['users', 1],
  ]);
  assert.equal(report.tables.every((entry) => entry.digest.length === 64), true);
  assert.deepEqual(target.table('users'), [{ id: 7, workspace_id: 1, active: true }]);
  assert.equal((target.table('workspaces')[0]?.created_at as Date).toISOString(),
    '2026-08-10T12:00:00.000Z');
  assert.equal(target.events.some((event) => event.startsWith('LOCK TABLE')), true);
  assert.equal(target.events.some((event) => event.startsWith('SELECT setval')), true);
});

test('database transfer rejects non-bootstrap target data before inserting', async () => {
  const source = sourceDatabase();
  const existingUser = { id: 99, workspace_id: 1, active: true };
  const target = new MemoryTransferDatabase('postgres', new Map([
    ['workspaces', [{ id: 1, name: 'Bootstrap', slug: 'local', created_at: new Date('2026-08-11T00:00:00Z') }]],
    ['users', [existingUser]],
  ]), tableMap);

  await assert.rejects(
    transferSqliteToPostgres({ source, target, catalog }),
    /contains business data in table users/,
  );
  assert.deepEqual(target.table('users'), [existingUser]);
});

test('database transfer accepts the wildcard meter price bootstrap catalog', async () => {
  const tables = new Map([[meterPrices.name, meterPrices]]);
  const source = new MemoryTransferDatabase(
    'sqlite',
    new Map([[meterPrices.name, structuredClone(meterRows)]]),
    tables,
  );
  const target = new MemoryTransferDatabase(
    'postgres',
    new Map([[meterPrices.name, structuredClone(meterRows)]]),
    tables,
  );

  await assert.doesNotReject(assertFreshTransferTarget(source, target, [meterPrices], 25));
});

test('database transfer rolls back the target when exact reconciliation fails', async () => {
  const source = sourceDatabase();
  const bootstrap = {
    id: 1,
    name: 'Bootstrap',
    slug: 'local',
    created_at: new Date('2026-08-11T00:00:00Z'),
  };
  const target = new MemoryTransferDatabase('postgres', new Map([
    ['workspaces', [bootstrap]],
    ['users', []],
  ]), tableMap, 'workspaces');

  await assert.rejects(
    transferSqliteToPostgres({ source, target, catalog }),
    /row mismatch for workspaces/,
  );
  assert.deepEqual(target.table('workspaces'), [{
    id: 1,
    name: 'Bootstrap',
    slug: 'local',
    created_at: new Date('2026-08-11T00:00:00Z'),
  }]);
  assert.deepEqual(target.table('users'), []);
});
