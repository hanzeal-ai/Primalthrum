import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

const MAX_SECRET_FILE_BYTES = 64 * 1024;

export const MANAGED_SECRET_KEYS = [
  'ABUSE_HASH_SECRET',
  'DATABASE_URL',
  'OBJECT_STORAGE_ACCESS_KEY_ID',
  'OBJECT_STORAGE_SECRET_ACCESS_KEY',
  'OBJECT_STORAGE_SESSION_TOKEN',
  'OPERATOR_BOOTSTRAP_TOKEN',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'PRIMALTHRUM_SECRET_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'TRANSACTIONAL_EMAIL_API_KEY',
  'TRANSACTIONAL_EMAIL_TOKEN',
  'TRANSACTIONAL_EMAIL_WEBHOOK_SECRET',
  'TURNSTILE_SECRET_KEY',
  'USAGE_METER_EXPORT_TOKEN',
] as const;

export async function loadManagedSecretEnvironment(
  environment: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
  const loaded: Array<{ fileKey: string; key: string; value: string }> = [];
  for (const key of MANAGED_SECRET_KEYS) {
    const fileKey = `${key}_FILE`;
    const filePath = environment[fileKey]?.trim();
    if (!filePath) continue;
    if (environment[key]?.trim()) {
      throw new Error(`${key} and ${fileKey} cannot both be set`);
    }
    loaded.push({ fileKey, key, value: await readSecretFile(fileKey, filePath) });
  }
  for (const secret of loaded) {
    environment[secret.key] = secret.value;
    delete environment[secret.fileKey];
  }
  return environment;
}

async function readSecretFile(fileKey: string, filePath: string): Promise<string> {
  if (!isAbsolute(filePath)) throw new Error(`${fileKey} must contain an absolute path`);
  let metadata;
  let content;
  try {
    metadata = await stat(filePath);
    if (!metadata.isFile()) throw new Error('not a regular file');
    if (metadata.size > MAX_SECRET_FILE_BYTES) throw new Error('file exceeds 64 KiB');
    if ((metadata.mode & 0o022) !== 0) throw new Error('file is group or world writable');
    content = await readFile(filePath, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'read failed';
    throw new Error(`${fileKey} cannot be loaded: ${detail}`);
  }
  const value = content.replace(/[\r\n]+$/, '');
  if (!value || /[\0\r\n]/.test(value)) {
    throw new Error(`${fileKey} must contain one non-empty line`);
  }
  return value;
}
