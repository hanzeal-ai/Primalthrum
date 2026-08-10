import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  type AsyncDatabaseAdapter,
  type AsyncDatabaseSession,
  type DatabaseCommandResult,
  type DatabaseStatement,
} from '../src/db/asyncAdapter';
import { POSTGRES_MIGRATIONS } from '../src/db/postgresMigrations';
import { createPostgresBackup } from '../src/services/postgres-backup/backup';
import { readPostgresBackupManifest } from '../src/services/postgres-backup/manifest';
import { restorePostgresBackup } from '../src/services/postgres-backup/restore';
import {
  type DatabaseFingerprint,
} from '../src/services/postgres-backup/types';

const CONNECTION_STRING = 'postgresql://backup-user:secret-value@db.example.com/primalthrum?sslmode=require';
const FINGERPRINT: DatabaseFingerprint = {
  migrationIds: POSTGRES_MIGRATIONS.map((migration) => migration.id),
  totalRows: 3,
  digestAlgorithm: 'sha256',
  tables: [{ table: 'workspaces', rows: 3, digest: 'a'.repeat(64) }],
};

class SnapshotDatabase implements AsyncDatabaseAdapter {
  readonly dialect = 'postgres' as const;
  readonly statements: string[] = [];

  async execute(statement: DatabaseStatement): Promise<DatabaseCommandResult> {
    this.statements.push(statement.text);
    return { rowCount: 0 };
  }

  async query<T extends object>(statement: DatabaseStatement): Promise<T[]> {
    this.statements.push(statement.text);
    if (statement.text.includes('pg_export_snapshot')) {
      return [{
        snapshot_id: '00000003-0000001A-1',
        server_version: '17.10',
        schema_name: 'public',
      }] as T[];
    }
    throw new Error(`unexpected snapshot query: ${statement.text}`);
  }

  async columns(): Promise<[]> {
    return [];
  }

  transaction<T>(operation: (session: AsyncDatabaseSession) => Promise<T>): Promise<T> {
    return operation(this);
  }

  async close(): Promise<void> {}
}

async function createFixtureBackup(root: string): Promise<string> {
  const backupDir = join(root, 'backup');
  await createPostgresBackup({
    database: new SnapshotDatabase(),
    connectionString: CONNECTION_STRING,
    backupDir,
    recoveryEvidence: {
      managedBackupReference: 'snapshot-123',
      objectStorageCheckpoint: 's3-version-456',
      secretRecoveryReference: 'vault-runbook-789',
      pitrRestorePoint: '2026-08-10T12:00:00.000Z',
    },
    now: () => new Date('2026-08-10T12:05:00Z'),
  }, {
    runProcess: async ({ args, env }) => {
      assert.equal(args.some((argument) => argument.includes(CONNECTION_STRING)), false);
      assert.equal(env.PGPASSWORD, 'secret-value');
      const file = args.find((argument) => argument.startsWith('--file='))?.slice('--file='.length);
      assert.ok(file);
      await writeFile(file, 'logical-backup', { mode: 0o600 });
    },
    captureFingerprint: async () => FINGERPRINT,
  });
  return backupDir;
}

test('PostgreSQL backup exports one snapshot and writes an integrity manifest without credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'primalthrum-pg-backup-'));
  const database = new SnapshotDatabase();
  const backupDir = join(root, 'backup');

  const manifest = await createPostgresBackup({
    database,
    connectionString: CONNECTION_STRING,
    backupDir,
    recoveryEvidence: { managedBackupReference: 'snapshot-123' },
    now: () => new Date('2026-08-10T12:05:00Z'),
  }, {
    runProcess: async ({ args, env }) => {
      assert.equal(args.includes('--snapshot=00000003-0000001A-1'), true);
      assert.equal(args.includes('--schema=public'), true);
      assert.equal(args.some((argument) => argument.includes('secret-value')), false);
      assert.equal(env.DATABASE_URL, undefined);
      const file = args.find((argument) => argument.startsWith('--file='))?.slice('--file='.length);
      assert.ok(file);
      await writeFile(file, 'logical-backup', { mode: 0o600 });
    },
    captureFingerprint: async () => FINGERPRINT,
  });

  assert.equal(manifest.database.bytes, Buffer.byteLength('logical-backup'));
  assert.match(manifest.database.sha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.recoveryEvidence.managedBackupReference, 'snapshot-123');
  assert.equal(manifest.recoveryEvidence.objectStorageCheckpoint, null);
  assert.equal(JSON.stringify(manifest).includes('secret-value'), false);
  assert.equal(database.statements[0]?.includes('REPEATABLE READ, READ ONLY'), true);
  assert.deepEqual(await readPostgresBackupManifest(join(backupDir, 'manifest.json')), manifest);
});

test('PostgreSQL backup removes partial output when pg_dump fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'primalthrum-pg-backup-fail-'));
  const backupDir = join(root, 'backup');
  await assert.rejects(
    createPostgresBackup({
      database: new SnapshotDatabase(),
      connectionString: CONNECTION_STRING,
      backupDir,
    }, {
      runProcess: async () => {
        throw new Error('forced dump failure');
      },
      captureFingerprint: async () => FINGERPRINT,
    }),
    /forced dump failure/,
  );
  assert.equal(await stat(backupDir).then(() => true).catch(() => false), false);
});

test('PostgreSQL restore verifies archive and restored fingerprint before writing evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'primalthrum-pg-restore-'));
  const backupDir = await createFixtureBackup(root);
  const reportPath = join(root, 'restore-report.json');
  let emptyTargetChecked = false;
  let restoreInvoked = false;

  const report = await restorePostgresBackup({
    database: new SnapshotDatabase(),
    connectionString: CONNECTION_STRING,
    backupDir,
    reportPath,
    now: () => new Date('2026-08-10T12:10:00Z'),
  }, {
    assertEmptyTarget: async () => {
      emptyTargetChecked = true;
    },
    runProcess: async ({ binary, args }) => {
      restoreInvoked = true;
      assert.equal(binary, 'pg_restore');
      assert.equal(args.includes('--single-transaction'), true);
    },
    captureFingerprint: async () => FINGERPRINT,
  });

  assert.equal(emptyTargetChecked, true);
  assert.equal(restoreInvoked, true);
  assert.equal(report.status, 'succeeded');
  assert.deepEqual(report.fingerprint, FINGERPRINT);
  assert.equal(await stat(reportPath).then((entry) => entry.isFile()), true);
});

test('PostgreSQL restore rejects a modified archive before invoking pg_restore', async () => {
  const root = await mkdtemp(join(tmpdir(), 'primalthrum-pg-restore-tamper-'));
  const backupDir = await createFixtureBackup(root);
  await appendFile(join(backupDir, 'database.pgdump'), 'tampered');
  let restoreInvoked = false;

  await assert.rejects(
    restorePostgresBackup({
      database: new SnapshotDatabase(),
      connectionString: CONNECTION_STRING,
      backupDir,
      reportPath: join(root, 'restore-report.json'),
    }, {
      assertEmptyTarget: async () => undefined,
      runProcess: async () => {
        restoreInvoked = true;
      },
      captureFingerprint: async () => FINGERPRINT,
    }),
    /size does not match|checksum does not match/,
  );
  assert.equal(restoreInvoked, false);
});

test('PostgreSQL restore preserves failed evidence when restored rows do not match', async () => {
  const root = await mkdtemp(join(tmpdir(), 'primalthrum-pg-restore-mismatch-'));
  const backupDir = await createFixtureBackup(root);
  const reportPath = join(root, 'restore-report.json');
  const mismatched: DatabaseFingerprint = {
    ...FINGERPRINT,
    tables: [{ ...FINGERPRINT.tables[0]!, digest: 'b'.repeat(64) }],
  };

  await assert.rejects(
    restorePostgresBackup({
      database: new SnapshotDatabase(),
      connectionString: CONNECTION_STRING,
      backupDir,
      reportPath,
    }, {
      assertEmptyTarget: async () => undefined,
      runProcess: async () => undefined,
      captureFingerprint: async () => mismatched,
    }),
    /fingerprint does not match/,
  );
  const failedReport = JSON.parse(await readFile(reportPath, 'utf8')) as Record<string, unknown>;
  assert.equal(failedReport.status, 'failed');
  assert.equal(JSON.stringify(failedReport).includes('secret-value'), false);
});
