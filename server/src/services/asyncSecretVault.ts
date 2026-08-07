import { randomUUID } from 'node:crypto';

import {
  type AsyncDatabaseAdapter,
  type AsyncDatabaseSession,
} from '../db/asyncAdapter';
import { decryptSecret, encryptSecret, normalizeSecret } from './secretEncryption';

const SECRET_REF_PREFIX = 'secret://local/';

interface SecretRow {
  ciphertext: string;
  iv: string;
  auth_tag: string;
}

export class AsyncSecretVault {
  constructor(private readonly database: AsyncDatabaseAdapter) {}

  create(plaintext: string, workspaceId: number): Promise<string> {
    return this.createInSession(this.database, plaintext, workspaceId);
  }

  async createInSession(
    session: AsyncDatabaseSession,
    plaintext: string,
    workspaceId: number,
  ): Promise<string> {
    const secretRef = `${SECRET_REF_PREFIX}${randomUUID()}`;
    await this.store(session, secretRef, plaintext, workspaceId);
    return secretRef;
  }

  update(secretRef: string, plaintext: string, workspaceId: number): Promise<void> {
    return this.updateInSession(this.database, secretRef, plaintext, workspaceId);
  }

  async updateInSession(
    session: AsyncDatabaseSession,
    secretRef: string,
    plaintext: string,
    workspaceId: number,
  ): Promise<void> {
    validateSecretRef(secretRef, 'updated');
    const result = await this.store(session, secretRef, plaintext, workspaceId);
    if (result === 0) throw new Error('provider secret not found');
  }

  async read(secretRef: string, workspaceId: number): Promise<string> {
    validateSecretRef(secretRef, 'read');
    const rows = await this.database.query<SecretRow>({
      text: `
        SELECT ciphertext, iv, auth_tag FROM secrets
        WHERE secret_ref = $1 AND workspace_id = $2 LIMIT 1;
      `,
      values: [secretRef, workspaceId],
    });
    if (!rows[0]) throw new Error('provider secret not found');
    return decryptSecret({
      ciphertext: rows[0].ciphertext,
      iv: rows[0].iv,
      authTag: rows[0].auth_tag,
    });
  }

  async delete(secretRef: string, workspaceId: number): Promise<void> {
    validateSecretRef(secretRef, 'deleted');
    await this.database.execute({
      text: 'DELETE FROM secrets WHERE secret_ref = $1 AND workspace_id = $2;',
      values: [secretRef, workspaceId],
    });
  }

  private async store(
    session: AsyncDatabaseSession,
    secretRef: string,
    plaintext: string,
    workspaceId: number,
  ): Promise<number> {
    const encrypted = encryptSecret(normalizeSecret(plaintext));
    const result = await session.execute({
      text: `
        INSERT INTO secrets (workspace_id, secret_ref, ciphertext, iv, auth_tag)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT(secret_ref) DO UPDATE SET
          ciphertext = excluded.ciphertext,
          iv = excluded.iv,
          auth_tag = excluded.auth_tag,
          updated_at = CURRENT_TIMESTAMP
        WHERE secrets.workspace_id = excluded.workspace_id;
      `,
      values: [
        workspaceId,
        secretRef,
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.authTag,
      ],
    });
    return result.rowCount;
  }
}

function validateSecretRef(secretRef: string, operation: string): void {
  if (!secretRef.startsWith(SECRET_REF_PREFIX)) {
    throw new Error(`only local secret refs can be ${operation}`);
  }
}
