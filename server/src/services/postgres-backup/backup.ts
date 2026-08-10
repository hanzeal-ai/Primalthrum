import { chmod, mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { POSTGRES_MIGRATIONS } from '../../db/postgresMigrations';
import { capturePostgresFingerprint } from './fingerprint';
import { sha256File, writeExclusiveJson } from './manifest';
import {
  postgresProcessEnvironment,
  runPostgresProcess,
  type ProcessRunner,
} from './process';
import {
  type PostgresBackupManifest,
  type PostgresBackupOptions,
  type RecoveryEvidence,
  type DatabaseFingerprint,
} from './types';
import { type AsyncDatabaseSession } from '../../db/asyncAdapter';

interface SnapshotRow {
  snapshot_id: string;
  server_version: string;
  schema_name: string;
}

export interface PostgresBackupDependencies {
  runProcess?: ProcessRunner;
  captureFingerprint?: (
    database: AsyncDatabaseSession,
    batchSize?: number,
  ) => Promise<DatabaseFingerprint>;
}

const ARCHIVE_NAME = 'database.pgdump';
const MANIFEST_NAME = 'manifest.json';

function recoveryEvidence(value: Partial<RecoveryEvidence> | undefined): RecoveryEvidence {
  return {
    managedBackupReference: value?.managedBackupReference ?? null,
    objectStorageCheckpoint: value?.objectStorageCheckpoint ?? null,
    secretRecoveryReference: value?.secretRecoveryReference ?? null,
    pitrRestorePoint: value?.pitrRestorePoint ?? null,
  };
}

export async function createPostgresBackup(
  options: PostgresBackupOptions,
  dependencies: PostgresBackupDependencies = {},
): Promise<PostgresBackupManifest> {
  if (options.database.dialect !== 'postgres') {
    throw new Error('PostgreSQL backup requires a PostgreSQL database');
  }
  const runProcess = dependencies.runProcess ?? runPostgresProcess;
  const captureFingerprint = dependencies.captureFingerprint ?? capturePostgresFingerprint;
  await mkdir(dirname(options.backupDir), { recursive: true, mode: 0o700 });
  await mkdir(options.backupDir, { recursive: false, mode: 0o700 });
  const partialArchivePath = join(options.backupDir, `${ARCHIVE_NAME}.partial`);
  const archivePath = join(options.backupDir, ARCHIVE_NAME);
  const manifestPath = join(options.backupDir, MANIFEST_NAME);

  try {
    const snapshot = await options.database.transaction(async (database) => {
      await database.execute({
        text: 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY;',
      });
      const rows = await database.query<SnapshotRow>({
        text: `
          SELECT
            pg_export_snapshot() AS snapshot_id,
            current_setting('server_version') AS server_version,
            current_schema() AS schema_name;
        `,
      });
      const row = rows[0];
      if (!row?.snapshot_id || !row.server_version) {
        throw new Error('PostgreSQL backup snapshot could not be exported');
      }
      if (row.schema_name !== 'public') {
        throw new Error('PostgreSQL backup currently requires the public application schema');
      }
      await runProcess({
        binary: options.pgDumpBinary ?? 'pg_dump',
        args: [
          '--format=custom',
          '--compress=9',
          '--no-owner',
          '--no-acl',
          '--schema=public',
          `--snapshot=${row.snapshot_id}`,
          `--file=${partialArchivePath}`,
        ],
        env: postgresProcessEnvironment(options.connectionString),
      });
      const fingerprint = await captureFingerprint(database, options.batchSize);
      return { serverVersion: row.server_version, fingerprint };
    });

    const expectedMigrations = POSTGRES_MIGRATIONS.map((migration) => migration.id);
    if (JSON.stringify(snapshot.fingerprint.migrationIds) !== JSON.stringify(expectedMigrations)) {
      throw new Error('PostgreSQL backup source migrations do not match the current application');
    }
    await chmod(partialArchivePath, 0o600);
    await rename(partialArchivePath, archivePath);
    const archiveStats = await stat(archivePath);
    if (!archiveStats.isFile() || archiveStats.size < 1) {
      throw new Error('PostgreSQL backup archive is empty');
    }
    const manifest: PostgresBackupManifest = {
      version: 1,
      kind: 'postgres-logical',
      createdAt: (options.now ?? (() => new Date()))().toISOString(),
      postgresServerVersion: snapshot.serverVersion,
      database: {
        file: ARCHIVE_NAME,
        schema: 'public',
        bytes: archiveStats.size,
        sha256: await sha256File(archivePath),
        fingerprint: snapshot.fingerprint,
      },
      recoveryEvidence: recoveryEvidence(options.recoveryEvidence),
    };
    await writeExclusiveJson(manifestPath, manifest);
    return manifest;
  } catch (error) {
    await rm(options.backupDir, { recursive: true, force: true });
    throw error;
  }
}
