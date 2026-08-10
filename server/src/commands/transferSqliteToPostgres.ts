import { mkdir, open, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { AsyncSqliteDatabase } from '../db/asyncSqlite';
import { runPostgresMigrations } from '../db/postgresMigrations';
import {
  assertTransferTargetMigrationState,
  inspectDatabaseTransferCatalog,
} from '../services/database-transfer/catalog';
import { transferSqliteToPostgres } from '../services/database-transfer/service';
import { configureApplicationDatabase } from '../services/applicationDatabaseConfiguration';

interface CommandOptions {
  sourcePath: string;
  reportPath: string;
  batchSize?: number;
}

function argumentValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function parseOptions(args: readonly string[], cwd: string): CommandOptions {
  if (!args.includes('--confirm-maintenance-window')) {
    throw new Error('--confirm-maintenance-window is required');
  }
  const source = argumentValue(args, '--source');
  const report = argumentValue(args, '--report');
  if (!source) throw new Error('--source is required');
  if (!report) throw new Error('--report is required');
  const rawBatchSize = argumentValue(args, '--batch-size');
  const parsedBatchSize = rawBatchSize === undefined ? undefined : Number(rawBatchSize);
  if (parsedBatchSize !== undefined && !Number.isInteger(parsedBatchSize)) {
    throw new Error('--batch-size must be an integer');
  }
  return {
    sourcePath: resolve(cwd, source),
    reportPath: resolve(cwd, report),
    ...(parsedBatchSize === undefined ? {} : { batchSize: parsedBatchSize }),
  };
}

function errorMessage(error: unknown, secret: string | undefined): string {
  const message = error instanceof Error ? error.message : 'database transfer failed';
  return secret ? message.split(secret).join('[redacted]') : message;
}

async function replaceReport(
  reportFile: Awaited<ReturnType<typeof open>>,
  value: object,
): Promise<void> {
  const content = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await reportFile.truncate(0);
  let offset = 0;
  while (offset < content.length) {
    const result = await reportFile.write(content, offset, content.length - offset, offset);
    offset += result.bytesWritten;
  }
  await reportFile.sync();
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2), process.cwd());
  const sourceStats = await stat(options.sourcePath);
  if (!sourceStats.isFile()) throw new Error('SQLite source must be an existing file');

  await mkdir(dirname(options.reportPath), { recursive: true });
  const reportFile = await open(options.reportPath, 'wx', 0o600);
  const startedAt = new Date().toISOString();
  let source: AsyncSqliteDatabase | undefined;
  let target: Awaited<ReturnType<typeof configureApplicationDatabase>>['database'];
  let operationFailed = false;
  try {
    await replaceReport(reportFile, { status: 'running', startedAt });
    source = new AsyncSqliteDatabase(options.sourcePath);
    await source.execute({ text: 'PRAGMA busy_timeout = 30000;' });
    const selection = await configureApplicationDatabase({
      ...process.env,
      NODE_ENV: 'production',
    }, {
      migratePostgres: async (database) => {
        await assertTransferTargetMigrationState(database);
        await runPostgresMigrations(database);
      },
    });
    if (!selection.database || selection.provider !== 'postgres') {
      throw new Error('PostgreSQL target configuration is required');
    }
    target = selection.database;

    const catalog = await inspectDatabaseTransferCatalog(source, target);
    const report = await transferSqliteToPostgres({
      source,
      target,
      catalog,
      batchSize: options.batchSize,
    });
    await replaceReport(reportFile, report);
    console.log(`Database transfer completed: ${report.totalRows} rows across ${report.tables.length} tables`);
    console.log(`Reconciliation report: ${options.reportPath}`);
  } catch (error) {
    operationFailed = true;
    const message = errorMessage(error, process.env.DATABASE_URL);
    await replaceReport(reportFile, {
      status: 'failed',
      startedAt,
      completedAt: new Date().toISOString(),
      error: message,
    }).catch(() => undefined);
    throw new Error(message);
  } finally {
    const closures = await Promise.allSettled([
      source?.close() ?? Promise.resolve(),
      target?.close() ?? Promise.resolve(),
      reportFile.close(),
    ]);
    const closeFailure = closures.find((result) => result.status === 'rejected');
    if (!operationFailed && closeFailure?.status === 'rejected') throw closeFailure.reason;
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'database transfer failed');
  process.exitCode = 1;
});
