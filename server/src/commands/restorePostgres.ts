import { resolve } from 'node:path';

import { PostgresDatabase } from '../db/postgres';
import { restorePostgresBackup } from '../services/postgres-backup/restore';
import {
  argumentValue,
  optionalBatchSize,
  requiredArgument,
  sanitizedCommandError,
} from '../services/postgres-backup/commandOptions';

async function main(): Promise<void> {
  const connectionString = process.env.RESTORE_DATABASE_URL;
  if (!connectionString) throw new Error('RESTORE_DATABASE_URL is required');
  const args = process.argv.slice(2);
  if (!args.includes('--confirm-empty-target')) {
    throw new Error('--confirm-empty-target is required');
  }
  const backupDir = resolve(process.cwd(), requiredArgument(args, '--backup-dir'));
  const reportPath = resolve(process.cwd(), requiredArgument(args, '--report'));
  const database = new PostgresDatabase({
    connectionString,
    max: 2,
    connectionTimeoutMillis: 15_000,
  });
  try {
    const report = await restorePostgresBackup({
      database,
      connectionString,
      backupDir,
      reportPath,
      batchSize: optionalBatchSize(args),
      pgRestoreBinary: argumentValue(args, '--pg-restore-bin'),
    });
    console.log(`PostgreSQL restore verified: ${report.fingerprint.totalRows} rows`);
    console.log(`Restore report: ${reportPath}`);
  } finally {
    await database.close();
  }
}

void main().catch((error: unknown) => {
  console.error(sanitizedCommandError(error, process.env.RESTORE_DATABASE_URL));
  process.exitCode = 1;
});
