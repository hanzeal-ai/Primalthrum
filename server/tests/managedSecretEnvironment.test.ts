import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createApplicationRuntime } from '../src/applicationRuntime';
import { loadManagedSecretEnvironment } from '../src/services/managedSecretEnvironment';
import { decryptSecret, encryptSecret } from '../src/services/secretEncryption';

test('managed secret files load allowlisted values without retaining file variables', async () => {
  await withSecretDirectory(async (root) => {
    const databaseFile = writeSecret(root, 'database-url', 'postgresql://user:secret@db/app\n');
    const environment: NodeJS.ProcessEnv = {
      DATABASE_URL_FILE: databaseFile,
      PUBLIC_APP_URL: 'https://agents.example.com',
    };

    const loaded = await loadManagedSecretEnvironment(environment);

    assert.equal(loaded, environment);
    assert.equal(loaded.DATABASE_URL, 'postgresql://user:secret@db/app');
    assert.equal(loaded.DATABASE_URL_FILE, undefined);
    assert.equal(loaded.PUBLIC_APP_URL, 'https://agents.example.com');
  });
});

test('managed secret loading fails closed for ambiguous or unsafe files', async () => {
  await withSecretDirectory(async (root) => {
    const secretFile = writeSecret(root, 'secret', 'file-value');
    const conflict: NodeJS.ProcessEnv = {
      STRIPE_SECRET_KEY: 'direct-value',
      STRIPE_SECRET_KEY_FILE: secretFile,
    };
    await assert.rejects(loadManagedSecretEnvironment(conflict), /cannot both be set/);
    assert.equal(conflict.STRIPE_SECRET_KEY, 'direct-value');

    await assert.rejects(
      loadManagedSecretEnvironment({ TURNSTILE_SECRET_KEY_FILE: 'relative-secret' }),
      /absolute path/,
    );
    const directory = join(root, 'directory');
    mkdirSync(directory);
    await assert.rejects(
      loadManagedSecretEnvironment({ ABUSE_HASH_SECRET_FILE: directory }),
      /not a regular file/,
    );
    const writable = writeSecret(root, 'writable', 'unsafe', 0o666);
    await assert.rejects(
      loadManagedSecretEnvironment({ PRIMALTHRUM_SECRET_KEY_FILE: writable }),
      /group or world writable/,
    );
    const multiline = writeSecret(root, 'multiline', 'first\nsecond');
    await assert.rejects(
      loadManagedSecretEnvironment({ OTEL_EXPORTER_OTLP_HEADERS_FILE: multiline }),
      /one non-empty line/,
    );
  });
});

test('runtime validates managed secret files before opening infrastructure', async () => {
  await assert.rejects(
    createApplicationRuntime({ DATABASE_URL_FILE: 'relative-database-secret' }),
    /DATABASE_URL_FILE must contain an absolute path/,
  );
});

test('mounted encryption key becomes the process key used by the secret vault', async () => {
  await withSecretDirectory(async (root) => {
    const previousEnvironment = {
      nodeEnv: process.env.NODE_ENV,
      secretKey: process.env.PRIMALTHRUM_SECRET_KEY,
      secretKeyFile: process.env.PRIMALTHRUM_SECRET_KEY_FILE,
    };
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.PRIMALTHRUM_SECRET_KEY;
      process.env.PRIMALTHRUM_SECRET_KEY_FILE = writeSecret(
        root,
        'encryption-key',
        'mounted-production-encryption-key',
      );
      await loadManagedSecretEnvironment(process.env);
      const encrypted = encryptSecret('provider-secret');
      assert.equal(decryptSecret(encrypted), 'provider-secret');
      assert.equal(process.env.PRIMALTHRUM_SECRET_KEY_FILE, undefined);
    } finally {
      restoreEnvironment('NODE_ENV', previousEnvironment.nodeEnv);
      restoreEnvironment('PRIMALTHRUM_SECRET_KEY', previousEnvironment.secretKey);
      restoreEnvironment('PRIMALTHRUM_SECRET_KEY_FILE', previousEnvironment.secretKeyFile);
    }
  });
});

function writeSecret(root: string, name: string, value: string, mode = 0o400): string {
  const path = join(root, name);
  writeFileSync(path, value, { mode });
  chmodSync(path, mode);
  return path;
}

async function withSecretDirectory(operation: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'primalthrum-managed-secrets-'));
  try {
    await operation(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function restoreEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
