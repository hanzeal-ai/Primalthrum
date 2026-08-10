import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  assertEmptyPostgresRestoreTarget,
  capturePostgresFingerprint,
} from './fingerprint';
import {
  fingerprintsMatch,
  openExclusiveJsonReport,
  readPostgresBackupManifest,
  replaceJsonReport,
  sha256File,
} from './manifest';
import {
  postgresProcessEnvironment,
  runPostgresProcess,
  type ProcessRunner,
} from './process';
import {
  type PostgresRestoreOptions,
  type PostgresRestoreReport,
  type DatabaseFingerprint,
} from './types';
import { type AsyncDatabaseSession } from '../../db/asyncAdapter';

export interface PostgresRestoreDependencies {
  runProcess?: ProcessRunner;
  assertEmptyTarget?: (database: AsyncDatabaseSession) => Promise<void>;
  captureFingerprint?: (
    database: AsyncDatabaseSession,
    batchSize?: number,
  ) => Promise<DatabaseFingerprint>;
}

export async function restorePostgresBackup(
  options: PostgresRestoreOptions,
  dependencies: PostgresRestoreDependencies = {},
): Promise<PostgresRestoreReport> {
  if (options.database.dialect !== 'postgres') {
    throw new Error('PostgreSQL restore requires a PostgreSQL database');
  }
  const manifestPath = join(options.backupDir, 'manifest.json');
  const archivePath = join(options.backupDir, 'database.pgdump');
  const manifest = await readPostgresBackupManifest(manifestPath);
  const archiveStats = await stat(archivePath).catch(() => null);
  if (!archiveStats?.isFile() || archiveStats.size !== manifest.database.bytes) {
    throw new Error('PostgreSQL backup archive size does not match its manifest');
  }
  const archiveSha256 = await sha256File(archivePath);
  if (archiveSha256 !== manifest.database.sha256) {
    throw new Error('PostgreSQL backup archive checksum does not match its manifest');
  }

  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const reportFile = await openExclusiveJsonReport(options.reportPath, {
    version: 1,
    status: 'running',
    startedAt,
    archiveSha256,
  });
  try {
    const assertEmptyTarget = dependencies.assertEmptyTarget ?? assertEmptyPostgresRestoreTarget;
    await options.database.transaction(async (database) => {
      await database.execute({
        text: 'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE, READ ONLY;',
      });
      await assertEmptyTarget(database);
    });
    await (dependencies.runProcess ?? runPostgresProcess)({
      binary: options.pgRestoreBinary ?? 'pg_restore',
      args: [
        '--single-transaction',
        '--exit-on-error',
        '--no-owner',
        '--no-acl',
        archivePath,
      ],
      env: postgresProcessEnvironment(options.connectionString),
    });
    const captureFingerprint = dependencies.captureFingerprint ?? capturePostgresFingerprint;
    const fingerprint = await options.database.transaction(async (database) => {
      await database.execute({
        text: 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY;',
      });
      return captureFingerprint(database, options.batchSize);
    });
    if (!fingerprintsMatch(manifest.database.fingerprint, fingerprint)) {
      throw new Error('PostgreSQL restored database fingerprint does not match the backup manifest');
    }

    const report: PostgresRestoreReport = {
      version: 1,
      status: 'succeeded',
      restoredAt: now().toISOString(),
      archiveSha256,
      fingerprint,
    };
    await replaceJsonReport(reportFile, report);
    return report;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'PostgreSQL restore failed';
    await replaceJsonReport(reportFile, {
      version: 1,
      status: 'failed',
      startedAt,
      completedAt: now().toISOString(),
      archiveSha256,
      error: message.split(options.connectionString).join('[redacted]'),
    }).catch(() => undefined);
    throw error;
  } finally {
    await reportFile.close();
  }
}
