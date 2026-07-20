import {
  createCipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';

import { initializeSchema } from '../db/schema';
import { SqliteDatabase, sqlValue } from '../db/sqlite';
import { DEFAULT_WORKSPACE_ID } from '../db/workspaceDefaults';

const SECRET_REF_PREFIX = 'secret://local/';

export class LocalSecretVault {
  constructor(private readonly db: SqliteDatabase) {
    initializeSchema(db);
  }

  create(plaintext: string): string {
    const secretRef = `${SECRET_REF_PREFIX}${randomUUID()}`;
    this.store(secretRef, plaintext);
    return secretRef;
  }

  update(secretRef: string, plaintext: string): void {
    if (!secretRef.startsWith(SECRET_REF_PREFIX)) {
      throw new Error('only local secret refs can be updated');
    }
    this.store(secretRef, plaintext);
  }

  private store(secretRef: string, plaintext: string): void {
    const encrypted = encryptSecret(normalizeSecret(plaintext));

    this.db.run(`
      INSERT INTO secrets (
        workspace_id,
        secret_ref,
        ciphertext,
        iv,
        auth_tag
      )
      VALUES (
        ${DEFAULT_WORKSPACE_ID},
        ${sqlValue(secretRef)},
        ${sqlValue(encrypted.ciphertext)},
        ${sqlValue(encrypted.iv)},
        ${sqlValue(encrypted.authTag)}
      )
      ON CONFLICT(secret_ref) DO UPDATE SET
        ciphertext = excluded.ciphertext,
        iv = excluded.iv,
        auth_tag = excluded.auth_tag,
        updated_at = CURRENT_TIMESTAMP;
    `);
  }
}

function normalizeSecret(secret: unknown): string {
  if (typeof secret !== 'string' || !secret.trim()) {
    throw new Error('secret is required');
  }
  return secret;
}

function encryptSecret(plaintext: string): {
  ciphertext: string;
  iv: string;
  authTag: string;
} {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secretKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

function secretKey(): Buffer {
  const keyMaterial = process.env.PRIMALTHRUM_SECRET_KEY
    ?? 'primalthrum-local-secret-key';
  return createHash('sha256').update(keyMaterial).digest();
}
