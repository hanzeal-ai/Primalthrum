import {
  type AsyncDatabaseSession,
  type DatabaseParameter,
} from '../../db/asyncAdapter';
import { quoteTransferIdentifier } from './catalog';
import { toTargetTransferValue } from './normalization';
import { type TransferTable } from './types';

interface CountRow {
  count: number | string;
}

function selectedColumns(table: TransferTable): string {
  return table.columns.map((column) => quoteTransferIdentifier(column.name)).join(', ');
}

function rowOrder(table: TransferTable): string {
  return table.primaryKey.map(quoteTransferIdentifier).join(', ');
}

export async function countTransferRows(
  session: AsyncDatabaseSession,
  table: TransferTable,
): Promise<number> {
  const rows = await session.query<CountRow>({
    text: `SELECT COUNT(*) AS count FROM ${quoteTransferIdentifier(table.name)};`,
  });
  const count = Number(rows[0]?.count ?? Number.NaN);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`database transfer row count is invalid for table ${table.name}`);
  }
  return count;
}

export async function readTransferRows(
  session: AsyncDatabaseSession,
  table: TransferTable,
  limit: number,
  offset: number,
): Promise<Record<string, unknown>[]> {
  return session.query<Record<string, unknown>>({
    text: `
      SELECT ${selectedColumns(table)}
      FROM ${quoteTransferIdentifier(table.name)}
      ORDER BY ${rowOrder(table)}
      LIMIT $1 OFFSET $2;
    `,
    values: [limit, offset],
  });
}

function insertStatement(
  table: TransferTable,
  rows: readonly Record<string, unknown>[],
): { text: string; values: DatabaseParameter[] } {
  const values: DatabaseParameter[] = [];
  const tuples = rows.map((row) => {
    const placeholders = table.columns.map((column) => {
      values.push(toTargetTransferValue(row[column.name], column.targetType));
      return `$${values.length}`;
    });
    return `(${placeholders.join(', ')})`;
  });
  const mutableColumns = table.columns.filter((column) => !table.primaryKey.includes(column.name));
  const conflictAction = mutableColumns.length === 0
    ? 'DO NOTHING'
    : `DO UPDATE SET ${mutableColumns.map((column) => {
        const name = quoteTransferIdentifier(column.name);
        return `${name} = EXCLUDED.${name}`;
      }).join(', ')}`;

  return {
    text: `
      INSERT INTO ${quoteTransferIdentifier(table.name)} (${selectedColumns(table)})
      VALUES ${tuples.join(', ')}
      ON CONFLICT (${table.primaryKey.map(quoteTransferIdentifier).join(', ')}) ${conflictAction};
    `,
    values,
  };
}

export async function copyTransferTable(
  source: AsyncDatabaseSession,
  target: AsyncDatabaseSession,
  table: TransferTable,
  batchSize: number,
): Promise<void> {
  for (let offset = 0; ; offset += batchSize) {
    const rows = await readTransferRows(source, table, batchSize, offset);
    if (rows.length === 0) return;
    await target.execute(insertStatement(table, rows));
    if (rows.length < batchSize) return;
  }
}

export async function resetTransferIdentitySequences(
  target: AsyncDatabaseSession,
  tables: readonly TransferTable[],
): Promise<void> {
  for (const table of tables) {
    for (const column of table.columns.filter((entry) => entry.identity)) {
      const tableName = quoteTransferIdentifier(table.name);
      const columnName = quoteTransferIdentifier(column.name);
      await target.query({
        text: `
          SELECT setval(
            pg_get_serial_sequence($1, $2)::regclass,
            COALESCE((SELECT MAX(${columnName}) FROM ${tableName}), 1),
            EXISTS(SELECT 1 FROM ${tableName})
          ) AS value;
        `,
        values: [table.name, column.name],
      });
    }
  }
}
