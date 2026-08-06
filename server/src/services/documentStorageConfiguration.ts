import { join } from 'node:path';

import { type DocumentFileStorage, LocalDocumentStorage } from './fileStorage';
import { S3DocumentStorage } from './s3DocumentStorage';

export function createDocumentFileStorage(
  env: NodeJS.ProcessEnv,
  options: { fetchImpl?: typeof fetch; now?: () => Date } = {},
): DocumentFileStorage {
  const production = env.NODE_ENV === 'production';
  const provider = (env.DOCUMENT_STORAGE_PROVIDER ?? 'local').trim().toLowerCase();
  if (provider === 'local') {
    if (production) {
      throw new Error('DOCUMENT_STORAGE_PROVIDER=s3 is required in production');
    }
    return new LocalDocumentStorage(
      env.DOCUMENT_STORAGE_DIR ?? join(process.cwd(), '..', 'data', 'documents'),
    );
  }
  if (provider !== 's3') throw new Error('DOCUMENT_STORAGE_PROVIDER must be local or s3');
  const endpoint = requiredEnv(env, 'OBJECT_STORAGE_ENDPOINT');
  if (production && new URL(endpoint).protocol !== 'https:') {
    throw new Error('OBJECT_STORAGE_ENDPOINT must use HTTPS in production');
  }
  return new S3DocumentStorage({
    accessKeyId: requiredEnv(env, 'OBJECT_STORAGE_ACCESS_KEY_ID'),
    bucket: requiredEnv(env, 'OBJECT_STORAGE_BUCKET'),
    endpoint,
    fetchImpl: options.fetchImpl,
    now: options.now,
    prefix: env.OBJECT_STORAGE_PREFIX,
    region: requiredEnv(env, 'OBJECT_STORAGE_REGION'),
    requestTimeoutMs: optionalPositiveInteger(env.OBJECT_STORAGE_TIMEOUT_MS),
    secretAccessKey: requiredEnv(env, 'OBJECT_STORAGE_SECRET_ACCESS_KEY'),
    sessionToken: env.OBJECT_STORAGE_SESSION_TOKEN,
  });
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required when DOCUMENT_STORAGE_PROVIDER=s3`);
  return value;
}

function optionalPositiveInteger(value: string | undefined): number | undefined {
  if (typeof value === 'undefined' || !value.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error('OBJECT_STORAGE_TIMEOUT_MS must be a positive integer');
  }
  return parsed;
}
