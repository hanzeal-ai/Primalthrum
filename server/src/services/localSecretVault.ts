import {
  randomUUID,
} from 'node:crypto';

import { type DatabaseAdapter } from '../db/adapter';
import { sqlValue } from '../db/sql';
import { decryptSecret, encryptSecret, normalizeSecret } from './secretEncryption';

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
    return decryptSecret({
      ciphertext: rows[0].ciphertext,
      iv: rows[0].iv,
      authTag: rows[0].auth_tag,
    });
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
