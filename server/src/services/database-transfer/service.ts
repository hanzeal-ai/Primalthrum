import { quoteTransferIdentifier } from './catalog';
import { assertFreshTransferTarget } from './preflight';
import { reconcileTransferTable } from './reconciliation';
import { copyTransferTable, resetTransferIdentitySequences } from './tableTransfer';
import {
  type DatabaseTransferOptions,
  type DatabaseTransferReport,
  type TableTransferReport,
} from './types';

const DEFAULT_BATCH_SIZE = 250;
const MAX_BATCH_SIZE = 1_000;

function validatedBatchSize(value: number | undefined): number {
  const selected = value ?? DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(selected) || selected < 1 || selected > MAX_BATCH_SIZE) {
    throw new Error(`database transfer batch size must be between 1 and ${MAX_BATCH_SIZE}`);
  }
  return selected;
}

export async function transferSqliteToPostgres(
  options: DatabaseTransferOptions,
): Promise<DatabaseTransferReport> {
  if (options.source.dialect !== 'sqlite' || options.target.dialect !== 'postgres') {
    throw new Error('database transfer requires a SQLite source and PostgreSQL target');
  }
  const batchSize = validatedBatchSize(options.batchSize);
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const tables = options.catalog.tables;

  const reports = await options.source.transaction((source) => (
    options.target.transaction(async (target) => {
      await target.execute({ text: "SET LOCAL lock_timeout = '30s';" });
      await target.execute({
        text: `LOCK TABLE ${tables.map((table) => quoteTransferIdentifier(table.name)).join(', ')} IN ACCESS EXCLUSIVE MODE;`,
      });
      await assertFreshTransferTarget(source, target, tables, batchSize);
      for (const table of tables) await copyTransferTable(source, target, table, batchSize);
      await resetTransferIdentitySequences(target, tables);

      const tableReports: TableTransferReport[] = [];
      for (const table of tables) {
        tableReports.push(await reconcileTransferTable(source, target, table, batchSize));
      }
      return tableReports;
    })
  ));

  return {
    status: 'succeeded',
    sourceDialect: 'sqlite',
    targetDialect: 'postgres',
    migrationIds: [...options.catalog.migrationIds],
    startedAt,
    completedAt: now().toISOString(),
    totalRows: reports.reduce((total, report) => total + report.rows, 0),
    digestAlgorithm: 'sha256',
    tables: reports,
  };
}
