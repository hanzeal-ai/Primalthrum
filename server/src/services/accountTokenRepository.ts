import { createHash, randomBytes } from 'node:crypto';

import { initializeSchema } from '../db/schema';
import { SqliteDatabase, sqlValue } from '../db/sqlite';

export type AccountTokenPurpose = 'verify_email' | 'reset_password';

export interface ConsumedAccountToken {
  userId: number;
  payload: Record<string, unknown>;
}

export class AccountTokenRepository {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {
    initializeSchema(db);
  }

  create(input: {
    userId: number;
    purpose: AccountTokenPurpose;
    ttlMs: number;
    payload?: Record<string, unknown>;
  }): string {
    const token = randomBytes(32).toString('base64url');
    const now = this.now().toISOString();
    const expiresAt = new Date(this.now().getTime() + input.ttlMs).toISOString();
    this.db.run(`
      UPDATE account_action_tokens
      SET used_at = COALESCE(used_at, ${sqlValue(now)})
      WHERE user_id = ${sqlValue(input.userId)}
        AND purpose = ${sqlValue(input.purpose)} AND used_at IS NULL;

      INSERT INTO account_action_tokens (
        user_id, purpose, token_hash, payload_json, expires_at
      ) VALUES (
        ${sqlValue(input.userId)}, ${sqlValue(input.purpose)},
        ${sqlValue(hashAccountToken(token))},
        ${sqlValue(JSON.stringify(input.payload ?? {}))}, ${sqlValue(expiresAt)}
      );
    `);
    return token;
  }

  consume(token: string, purpose: AccountTokenPurpose): ConsumedAccountToken | null {
    if (!token.trim()) return null;
    const row = this.db.query<{
      user_id: number;
      payload_json: string;
    }>(`
      UPDATE account_action_tokens
      SET used_at = ${sqlValue(this.now().toISOString())}
      WHERE token_hash = ${sqlValue(hashAccountToken(token))}
        AND purpose = ${sqlValue(purpose)}
        AND used_at IS NULL
        AND datetime(expires_at) > datetime(${sqlValue(this.now().toISOString())})
      RETURNING user_id, payload_json;
    `)[0];
    return row ? {
      userId: Number(row.user_id),
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    } : null;
  }
}

function hashAccountToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
