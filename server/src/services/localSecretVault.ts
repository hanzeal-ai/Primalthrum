import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';

import { type DatabaseAdapter } from '../db/adapter';
import { sqlValue } from '../db/sql';

const SECRET_REF_PREFIX = 'secret://local/';

export class LocalSecretVault {
  constructor(private readonly db: DatabaseAdapter) {
  }

  create(plaintext: string, workspaceId: number): string {
    const secretRef = `${SECRET_REF_PREFIX}${randomUUID()}`;
    this.store(secretRef, plaintext, workspaceId);
    return secretRef;
  }

  update(secretRef: string, plaintext: string, workspaceId: number): void {
    if (!secretRef.startsWith(SECRET_REF_PREFIX)) {
      throw new Error('only local secret refs can be updated');
    }
    this.store(secretRef, plaintext, workspaceId);
  }

  read(secretRef: string, workspaceId: number): string {
    if (!secretRef.startsWith(SECRET_REF_PREFIX)) {
      throw new Error('only local secret refs can be read');
    }
    const rows = this.db.query<{
      ciphertext: string;
      iv: string;
      auth_tag: string;
    }>(`
      SELECT ciphertext, iv, auth_tag
      FROM secrets
      WHERE secret_ref = ${sqlValue(secretRef)}
        AND workspace_id = ${sqlValue(workspaceId)}
      LIMIT 1;
    `);
    if (!rows[0]) throw new Error('provider secret not found');
    return decryptSecret(rows[0]);
  }

  delete(secretRef: string, workspaceId: number): void {
    if (!secretRef.startsWith(SECRET_REF_PREFIX)) {
      throw new Error('only local secret refs can be deleted');
    }
    this.db.run(`
      DELETE FROM secrets
      WHERE secret_ref = ${sqlValue(secretRef)}
        AND workspace_id = ${sqlValue(workspaceId)};
    `);
  }

  private store(secretRef: string, plaintext: string, workspaceId: number): void {
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
        ${sqlValue(workspaceId)},
        ${sqlValue(secretRef)},
        ${sqlValue(encrypted.ciphertext)},
        ${sqlValue(encrypted.iv)},
        ${sqlValue(encrypted.authTag)}
      )
      ON CONFLICT(secret_ref) DO UPDATE SET
        ciphertext = excluded.ciphertext,
        iv = excluded.iv,
        auth_tag = excluded.auth_tag,
        updated_at = CURRENT_TIMESTAMP
      WHERE secrets.workspace_id = excluded.workspace_id;
    `);
  }
}

function decryptSecret(encrypted: {
  ciphertext: string;
  iv: string;
  auth_tag: string;
}): string {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    secretKey(),
    Buffer.from(encrypted.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(encrypted.auth_tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
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
