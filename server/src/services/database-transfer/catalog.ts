import { type AsyncDatabaseAdapter } from '../../db/asyncAdapter';
import { POSTGRES_MIGRATIONS } from '../../db/postgresMigrations';
import {
  type DatabaseTransferCatalog,
  type TransferColumn,
  type TransferTable,
} from './types';

interface NamedRow {
  name: string;
}

interface MigrationRow {
  id: string;
}

interface SqliteColumnRow {
  name: string;
  pk: number;
}

interface TargetColumnRow {
  table_name: string;
  name: string;
  target_type: string;
  is_identity: boolean;
  primary_key_position: number | string | null;
}

interface ForeignKeyRow {
  table_name: string;
  referenced_table: string;
}

interface RelationRow {
  name: string | null;
}

const IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function quoteTransferIdentifier(identifier: string): string {
  if (!IDENTIFIER.test(identifier)) {
    throw new Error(`database transfer identifier is invalid: ${identifier}`);
  }
  return `"${identifier}"`;
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  return sameValues(sorted(left), sorted(right));
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

async function migrationIds(database: AsyncDatabaseAdapter): Promise<string[]> {
  const rows = await database.query<MigrationRow>({
    text: 'SELECT id FROM schema_migrations ORDER BY id ASC;',
  });
  return rows.map((row) => row.id);
}

async function sourceTables(database: AsyncDatabaseAdapter): Promise<string[]> {
  const rows = await database.query<NamedRow>({
    text: `
      SELECT name
      FROM sqlite_schema
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
        AND name <> 'schema_migrations'
      ORDER BY name ASC;
    `,
  });
  return rows.map((row) => row.name);
}

async function targetTables(database: AsyncDatabaseAdapter): Promise<string[]> {
  const rows = await database.query<NamedRow>({
    text: `
      SELECT table_name AS name
      FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_type = 'BASE TABLE'
        AND table_name <> 'schema_migrations'
      ORDER BY table_name ASC;
    `,
  });
  return rows.map((row) => row.name);
}

async function sourceColumns(
  database: AsyncDatabaseAdapter,
  tableName: string,
): Promise<SqliteColumnRow[]> {
  return database.query<SqliteColumnRow>({
    text: `PRAGMA table_info(${quoteTransferIdentifier(tableName)});`,
  });
}

async function targetColumns(database: AsyncDatabaseAdapter): Promise<TargetColumnRow[]> {
  return database.query<TargetColumnRow>({
    text: `
      SELECT
        c.table_name,
        c.column_name AS name,
        c.udt_name AS target_type,
        (c.is_identity = 'YES') AS is_identity,
        pk.ordinal_position AS primary_key_position
      FROM information_schema.columns c
      LEFT JOIN (
        SELECT kcu.table_name, kcu.column_name, kcu.ordinal_position
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON kcu.constraint_catalog = tc.constraint_catalog
         AND kcu.constraint_schema = tc.constraint_schema
         AND kcu.constraint_name = tc.constraint_name
        WHERE tc.table_schema = current_schema()
          AND tc.constraint_type = 'PRIMARY KEY'
      ) pk
        ON pk.table_name = c.table_name
       AND pk.column_name = c.column_name
      WHERE c.table_schema = current_schema()
      ORDER BY c.table_name ASC, c.ordinal_position ASC;
    `,
  });
}

async function foreignKeys(database: AsyncDatabaseAdapter): Promise<ForeignKeyRow[]> {
  return database.query<ForeignKeyRow>({
    text: `
      SELECT DISTINCT
        tc.table_name,
        ccu.table_name AS referenced_table
      FROM information_schema.table_constraints tc
      JOIN information_schema.referential_constraints rc
        ON rc.constraint_catalog = tc.constraint_catalog
       AND rc.constraint_schema = tc.constraint_schema
       AND rc.constraint_name = tc.constraint_name
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_catalog = rc.unique_constraint_catalog
       AND ccu.constraint_schema = rc.unique_constraint_schema
       AND ccu.constraint_name = rc.unique_constraint_name
      WHERE tc.table_schema = current_schema()
        AND tc.constraint_type = 'FOREIGN KEY'
      ORDER BY tc.table_name ASC, ccu.table_name ASC;
    `,
  });
}

function orderByDependencies(tables: TransferTable[]): TransferTable[] {
  const pending = new Map(tables.map((table) => [table.name, table]));
  const completed = new Set<string>();
  const ordered: TransferTable[] = [];

  while (pending.size > 0) {
    const ready = [...pending.values()]
      .filter((table) => table.dependencies.every((dependency) => completed.has(dependency)))
      .sort((left, right) => left.name.localeCompare(right.name));
    if (ready.length === 0) {
      throw new Error(`database transfer foreign-key cycle detected: ${sorted(pending.keys()).join(', ')}`);
    }
    for (const table of ready) {
      pending.delete(table.name);
      completed.add(table.name);
      ordered.push(table);
    }
  }

  return ordered;
}

export async function assertTransferTargetMigrationState(
  target: AsyncDatabaseAdapter,
): Promise<void> {
  if (target.dialect !== 'postgres') {
    throw new Error('database transfer target must be PostgreSQL');
  }
  const relation = await target.query<RelationRow>({
    text: `SELECT to_regclass(current_schema() || '.schema_migrations') AS name;`,
  });
  const expectedMigrationIds = POSTGRES_MIGRATIONS.map((migration) => migration.id);
  if (!relation[0]?.name) {
    if ((await targetTables(target)).length > 0) {
      throw new Error('PostgreSQL transfer target is not an empty dedicated database');
    }
    return;
  }
  if (!sameValues(await migrationIds(target), expectedMigrationIds)) {
    throw new Error('PostgreSQL transfer target has a partial or outdated migration state');
  }
}

export async function inspectDatabaseTransferCatalog(
  source: AsyncDatabaseAdapter,
  target: AsyncDatabaseAdapter,
): Promise<DatabaseTransferCatalog> {
  if (source.dialect !== 'sqlite' || target.dialect !== 'postgres') {
    throw new Error('database transfer requires a SQLite source and PostgreSQL target');
  }

  const expectedMigrationIds = POSTGRES_MIGRATIONS.map((migration) => migration.id);
  const sourceMigrationIds = await migrationIds(source);
  const targetMigrationIds = await migrationIds(target);
  if (!sameValues(sourceMigrationIds, expectedMigrationIds)) {
    throw new Error('SQLite source migrations do not match the current application schema');
  }
  if (!sameValues(targetMigrationIds, expectedMigrationIds)) {
    throw new Error('PostgreSQL target migrations do not match the current application schema');
  }

  const sourceTableNames = await sourceTables(source);
  const targetTableNames = await targetTables(target);
  if (!sameValues(sourceTableNames, targetTableNames)) {
    throw new Error('SQLite source and PostgreSQL target table sets do not match');
  }
  sourceTableNames.forEach(quoteTransferIdentifier);

  const targetColumnRows = await targetColumns(target);
  const foreignKeyRows = await foreignKeys(target);
  const tableSet = new Set(targetTableNames);
  const tables: TransferTable[] = [];

  for (const tableName of targetTableNames) {
    const sqliteColumns = await sourceColumns(source, tableName);
    const postgresColumns = targetColumnRows.filter((column) => column.table_name === tableName);
    const sourceNames = sqliteColumns.map((column) => column.name);
    const targetNames = postgresColumns.map((column) => column.name);
    if (!sameMembers(sourceNames, targetNames)) {
      throw new Error(`database transfer column mismatch for table ${tableName}`);
    }

    const sourcePrimaryKey = sqliteColumns
      .filter((column) => Number(column.pk) > 0)
      .sort((left, right) => Number(left.pk) - Number(right.pk))
      .map((column) => column.name);
    const columns: TransferColumn[] = postgresColumns.map((column) => ({
      name: column.name,
      targetType: column.target_type,
      primaryKeyPosition: Number(column.primary_key_position ?? 0),
      identity: Boolean(column.is_identity),
    }));
    const targetPrimaryKey = columns
      .filter((column) => column.primaryKeyPosition > 0)
      .sort((left, right) => left.primaryKeyPosition - right.primaryKeyPosition)
      .map((column) => column.name);
    if (!sameValues(sourcePrimaryKey, targetPrimaryKey)) {
      throw new Error(`database transfer primary-key mismatch for table ${tableName}`);
    }
    if (targetPrimaryKey.length === 0) {
      throw new Error(`database transfer requires a primary key for table ${tableName}`);
    }

    const dependencies = sorted(new Set(
      foreignKeyRows
        .filter((key) => key.table_name === tableName)
        .map((key) => key.referenced_table)
        .filter((dependency) => dependency !== tableName && tableSet.has(dependency)),
    ));
    tables.push({ name: tableName, columns, primaryKey: targetPrimaryKey, dependencies });
  }

  return {
    migrationIds: expectedMigrationIds,
    tables: orderByDependencies(tables),
  };
}
