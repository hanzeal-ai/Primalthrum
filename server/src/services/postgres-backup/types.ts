import { type AsyncDatabaseAdapter } from '../../db/asyncAdapter';

export interface DatabaseFingerprintTable {
  table: string;
  rows: number;
  digest: string;
}

export interface DatabaseFingerprint {
  migrationIds: string[];
  totalRows: number;
  digestAlgorithm: 'sha256';
  tables: DatabaseFingerprintTable[];
}

export interface RecoveryEvidence {
  managedBackupReference: string | null;
  objectStorageCheckpoint: string | null;
  secretRecoveryReference: string | null;
  pitrRestorePoint: string | null;
}

export interface PostgresBackupManifest {
  version: 1;
  kind: 'postgres-logical';
  createdAt: string;
  postgresServerVersion: string;
  database: {
    file: 'database.pgdump';
    schema: 'public';
    bytes: number;
    sha256: string;
    fingerprint: DatabaseFingerprint;
  };
  recoveryEvidence: RecoveryEvidence;
}

export interface PostgresRestoreReport {
  version: 1;
  status: 'succeeded';
  restoredAt: string;
  archiveSha256: string;
  fingerprint: DatabaseFingerprint;
}

export interface PostgresBackupOptions {
  database: AsyncDatabaseAdapter;
  connectionString: string;
  backupDir: string;
  recoveryEvidence?: Partial<RecoveryEvidence>;
  pgDumpBinary?: string;
  batchSize?: number;
  now?: () => Date;
}

export interface PostgresRestoreOptions {
  database: AsyncDatabaseAdapter;
  connectionString: string;
  backupDir: string;
  reportPath: string;
  pgRestoreBinary?: string;
  batchSize?: number;
  now?: () => Date;
}
