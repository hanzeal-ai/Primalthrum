import { createHash } from 'node:crypto';

import { type AsyncDatabaseSession } from '../../db/asyncAdapter';
import { quoteTransferIdentifier } from '../database-transfer/catalog';
import { canonicalTransferRow } from '../database-transfer/normalization';
import { countTransferRows, readTransferRows } from '../database-transfer/tableTransfer';
import { type TransferColumn, type TransferTable } from '../database-transfer/types';
import { type DatabaseFingerprint, type DatabaseFingerprintTable } from './types';

interface NamedRow {
  name: string;
}

interface MigrationRow {
  id: string;
}

interface ColumnRow {
  table_name: string;
  name: string;
  target_type: string;
  is_identity: boolean;
  primary_key_position: number | string | null;
}

async function snapshotTables(database: AsyncDatabaseSession): Promise<TransferTable[]> {
  const names = await database.query<NamedRow>({
    text: `
      SELECT table_name AS name
      FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_type = 'BASE TABLE'
        AND table_name <> 'schema_migrations'
      ORDER BY table_name ASC;
    `,
  });
  const columns = await database.query<ColumnRow>({
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

  return names.map(({ name }) => {
    quoteTransferIdentifier(name);
    const tableColumns: TransferColumn[] = columns
      .filter((column) => column.table_name === name)
      .map((column) => ({
        name: column.name,
        targetType: column.target_type,
        identity: Boolean(column.is_identity),
        primaryKeyPosition: Number(column.primary_key_position ?? 0),
      }));
    const primaryKey = tableColumns
      .filter((column) => column.primaryKeyPosition > 0)
      .sort((left, right) => left.primaryKeyPosition - right.primaryKeyPosition)
      .map((column) => column.name);
    if (tableColumns.length === 0 || primaryKey.length === 0) {
      throw new Error(`PostgreSQL backup requires a primary key for table ${name}`);
    }
    return { name, columns: tableColumns, primaryKey, dependencies: [] };
  });
}

async function fingerprintTable(
  database: AsyncDatabaseSession,
  table: TransferTable,
  batchSize: number,
): Promise<DatabaseFingerprintTable> {
  const rows = await countTransferRows(database, table);
  const digest = createHash('sha256');
  for (let offset = 0; offset < rows; offset += batchSize) {
    const page = await readTransferRows(database, table, batchSize, offset);
    for (const row of page) digest.update(`${canonicalTransferRow(row, table.columns)}\n`);
  }
  return { table: table.name, rows, digest: digest.digest('hex') };
}

export async function capturePostgresFingerprint(
  database: AsyncDatabaseSession,
  batchSize = 250,
): Promise<DatabaseFingerprint> {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
    throw new Error('PostgreSQL backup batch size must be between 1 and 1000');
  }
  const migrationRows = await database.query<MigrationRow>({
    text: 'SELECT id FROM schema_migrations ORDER BY id ASC;',
  });
  const tables = await snapshotTables(database);
  const reports: DatabaseFingerprintTable[] = [];
  for (const table of tables) reports.push(await fingerprintTable(database, table, batchSize));
  return {
    migrationIds: migrationRows.map((row) => row.id),
    totalRows: reports.reduce((total, table) => total + table.rows, 0),
    digestAlgorithm: 'sha256',
    tables: reports,
  };
}

export async function assertEmptyPostgresRestoreTarget(
  database: AsyncDatabaseSession,
): Promise<void> {
  const objects = await database.query<NamedRow>({
    text: `
      SELECT object_name AS name
      FROM (
        SELECT n.nspname || '.' || c.relname AS object_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND n.nspname NOT LIKE 'pg_toast%'
          AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
        UNION ALL
        SELECT n.nspname || '.' || p.proname AS object_name
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND n.nspname NOT LIKE 'pg_toast%'
      ) user_objects
      LIMIT 1;
    `,
  });
  if (objects.length > 0) throw new Error('PostgreSQL restore target must be an empty dedicated database');
}
