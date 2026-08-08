import { createHash, randomBytes } from 'node:crypto';

import { type DatabaseAdapter } from '../db/adapter';
import { sqlValue } from '../db/sql';
import {
  type AccountTokenPurpose,
  type AccountTokenStore,
  type ConsumedAccountToken,
  type CreateAccountTokenInput,
} from './accountTokenStore';

export class AccountTokenRepository implements AccountTokenStore {
  constructor(
    private readonly db: DatabaseAdapter,
    private readonly now: () => Date = () => new Date(),
  ) {
  }

  create(input: CreateAccountTokenInput): string {
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
