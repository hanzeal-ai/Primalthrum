import { resolve } from 'node:path';

import { PostgresDatabase } from '../db/postgres';
import { createPostgresBackup } from '../services/postgres-backup/backup';
import {
  argumentValue,
  optionalBatchSize,
  requiredArgument,
  sanitizedCommandError,
} from '../services/postgres-backup/commandOptions';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const args = process.argv.slice(2);
  const backupDir = resolve(process.cwd(), requiredArgument(args, '--backup-dir'));
  const database = new PostgresDatabase({
    connectionString,
    max: 2,
    connectionTimeoutMillis: 15_000,
  });
  try {
    const manifest = await createPostgresBackup({
      database,
      connectionString,
      backupDir,
      batchSize: optionalBatchSize(args),
      pgDumpBinary: argumentValue(args, '--pg-dump-bin'),
      recoveryEvidence: {
        managedBackupReference: argumentValue(args, '--managed-backup-ref'),
        objectStorageCheckpoint: argumentValue(args, '--object-checkpoint'),
        secretRecoveryReference: argumentValue(args, '--secret-recovery-ref'),
        pitrRestorePoint: argumentValue(args, '--pitr-restore-point'),
      },
    });
    console.log(`PostgreSQL backup created: ${backupDir}`);
    console.log(`Archive SHA-256: ${manifest.database.sha256}`);
    console.log(`Fingerprint rows: ${manifest.database.fingerprint.totalRows}`);
  } finally {
    await database.close();
  }
}

void main().catch((error: unknown) => {
  console.error(sanitizedCommandError(error, process.env.DATABASE_URL));
  process.exitCode = 1;
});
