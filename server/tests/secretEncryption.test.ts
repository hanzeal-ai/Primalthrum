import assert from 'node:assert/strict';
import test from 'node:test';

import { decryptSecret, encryptSecret } from '../src/services/secretEncryption';

test('secret encryption round-trips with authenticated ciphertext', () => {
  const previousKey = process.env.PRIMALTHRUM_SECRET_KEY;
  const previousEnvironment = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'test';
    process.env.PRIMALTHRUM_SECRET_KEY = 'test-secret-encryption-key';
    const encrypted = encryptSecret("provider-secret-'value");
    assert.notEqual(encrypted.ciphertext, "provider-secret-'value");
    assert.equal(decryptSecret(encrypted), "provider-secret-'value");
    assert.throws(
      () => decryptSecret({ ...encrypted, authTag: Buffer.alloc(16).toString('base64') }),
    );
  } finally {
    restoreEnvironment('PRIMALTHRUM_SECRET_KEY', previousKey);
    restoreEnvironment('NODE_ENV', previousEnvironment);
  }
});

test('secret encryption fails closed without a production key', () => {
  const previousKey = process.env.PRIMALTHRUM_SECRET_KEY;
  const previousEnvironment = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.PRIMALTHRUM_SECRET_KEY;
    assert.throws(() => encryptSecret('secret'), /PRIMALTHRUM_SECRET_KEY is required/);
  } finally {
    restoreEnvironment('PRIMALTHRUM_SECRET_KEY', previousKey);
    restoreEnvironment('NODE_ENV', previousEnvironment);
  }
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (typeof value === 'undefined') delete process.env[name];
  else process.env[name] = value;
}
