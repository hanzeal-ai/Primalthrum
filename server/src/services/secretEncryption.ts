import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  authTag: string;
}

export function normalizeSecret(secret: unknown): string {
  if (typeof secret !== 'string' || !secret.trim()) {
    throw new Error('secret is required');
  }
  return secret;
}

export function encryptSecret(plaintext: string): EncryptedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secretKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(normalizeSecret(plaintext), 'utf8'),
    cipher.final(),
  ]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

export function decryptSecret(encrypted: EncryptedSecret): string {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    secretKey(),
    Buffer.from(encrypted.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(encrypted.authTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function secretKey(): Buffer {
  const configuredKey = process.env.PRIMALTHRUM_SECRET_KEY?.trim();
  if (!configuredKey && process.env.NODE_ENV === 'production') {
    throw new Error('PRIMALTHRUM_SECRET_KEY is required in production');
  }
  const keyMaterial = configuredKey || 'primalthrum-local-secret-key';
  return createHash('sha256').update(keyMaterial).digest();
}
