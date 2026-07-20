import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export interface BackupInput {
  dbPath: string;
  documentStorageDir: string;
  backupDir: string;
}

export interface BackupManifest {
  version: 1;
  createdAt: string;
  includes: {
    database: string;
    documents: string;
  };
}

const DB_BACKUP_NAME = 'platform.sqlite';
const DOCUMENTS_BACKUP_NAME = 'documents';
const MANIFEST_NAME = 'manifest.json';

export function createBackup(input: BackupInput): BackupManifest {
  mkdirSync(input.backupDir, { recursive: true });
  copyFileIfPresent(input.dbPath, join(input.backupDir, DB_BACKUP_NAME));
  copyDirectoryIfPresent(
    input.documentStorageDir,
    join(input.backupDir, DOCUMENTS_BACKUP_NAME),
  );

  const manifest: BackupManifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    includes: {
      database: DB_BACKUP_NAME,
      documents: DOCUMENTS_BACKUP_NAME,
    },
  };
  writeFileSync(
    join(input.backupDir, MANIFEST_NAME),
    JSON.stringify(manifest, null, 2),
    'utf8',
  );
  return manifest;
}

export function restoreBackup(input: BackupInput): BackupManifest {
  const manifestPath = join(input.backupDir, MANIFEST_NAME);
  if (!existsSync(manifestPath)) {
    throw new Error('backup manifest not found');
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BackupManifest;
  const sourceDbPath = join(input.backupDir, manifest.includes.database);
  const sourceDocumentsDir = join(input.backupDir, manifest.includes.documents);

  if (!existsSync(sourceDbPath)) {
    throw new Error('backup database not found');
  }

  mkdirSync(dirname(input.dbPath), { recursive: true });
  cpSync(sourceDbPath, input.dbPath);

  rmSync(input.documentStorageDir, { recursive: true, force: true });
  copyDirectoryIfPresent(sourceDocumentsDir, input.documentStorageDir);

  return manifest;
}

function copyFileIfPresent(source: string, target: string): void {
  if (!existsSync(source)) {
    return;
  }

  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target);
}

function copyDirectoryIfPresent(source: string, target: string): void {
  if (!existsSync(source)) {
    mkdirSync(target, { recursive: true });
    return;
  }

  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true });
}
