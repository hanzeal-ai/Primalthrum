import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  type DatabaseFingerprint,
  type PostgresBackupManifest,
} from './types';

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return hash.digest('hex');
}

function validDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function validFingerprint(value: unknown): value is DatabaseFingerprint {
  if (!value || typeof value !== 'object') return false;
  const fingerprint = value as Partial<DatabaseFingerprint>;
  if (!(fingerprint.digestAlgorithm === 'sha256'
    && Array.isArray(fingerprint.migrationIds)
    && fingerprint.migrationIds.every((entry) => typeof entry === 'string')
    && Number.isSafeInteger(fingerprint.totalRows)
    && (fingerprint.totalRows ?? -1) >= 0
    && Array.isArray(fingerprint.tables)
    && fingerprint.tables.every((table) => (
      typeof table?.table === 'string' && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table.table)
      && Number.isSafeInteger(table.rows)
      && table.rows >= 0
      && validDigest(table.digest)
    )))) return false;
  const tables = fingerprint.tables ?? [];
  const names = tables.map((table) => table.table);
  return names.every((name, index) => index === 0 || name > (names[index - 1] ?? ''))
    && tables.reduce((total, table) => total + table.rows, 0) === fingerprint.totalRows;
}

function validRecoveryEvidence(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const evidence = value as Record<string, unknown>;
  const names = [
    'managedBackupReference',
    'objectStorageCheckpoint',
    'secretRecoveryReference',
    'pitrRestorePoint',
  ];
  return Object.keys(evidence).length === names.length
    && names.every((name) => evidence[name] === null || typeof evidence[name] === 'string');
}

export async function readPostgresBackupManifest(path: string): Promise<PostgresBackupManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error('PostgreSQL backup manifest is unreadable');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('PostgreSQL backup manifest is invalid');
  const manifest = parsed as Partial<PostgresBackupManifest>;
  if (
    manifest.version !== 1
    || manifest.kind !== 'postgres-logical'
    || typeof manifest.createdAt !== 'string' || Number.isNaN(Date.parse(manifest.createdAt))
    || typeof manifest.postgresServerVersion !== 'string'
    || manifest.database?.file !== 'database.pgdump'
    || manifest.database.schema !== 'public'
    || !Number.isSafeInteger(manifest.database.bytes)
    || manifest.database.bytes < 1
    || !validDigest(manifest.database.sha256)
    || !validFingerprint(manifest.database.fingerprint)
    || !validRecoveryEvidence(manifest.recoveryEvidence)
  ) {
    throw new Error('PostgreSQL backup manifest is invalid');
  }
  return manifest as PostgresBackupManifest;
}

export async function writeExclusiveJson(path: string, value: object): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(path, 'wx', 0o600);
  try {
    await replaceJsonReport(file, value);
  } finally {
    await file.close();
  }
}

export async function openExclusiveJsonReport(path: string, value: object): Promise<FileHandle> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(path, 'wx', 0o600);
  try {
    await replaceJsonReport(file, value);
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

export async function replaceJsonReport(file: FileHandle, value: object): Promise<void> {
  const content = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await file.truncate(0);
  let offset = 0;
  while (offset < content.length) {
    const result = await file.write(content, offset, content.length - offset, offset);
    offset += result.bytesWritten;
  }
  await file.sync();
}

export function fingerprintsMatch(
  expected: DatabaseFingerprint,
  actual: DatabaseFingerprint,
): boolean {
  return JSON.stringify(expected) === JSON.stringify(actual);
}
