import { createHash, randomBytes } from 'node:crypto';

import { type AsyncDatabaseAdapter } from '../db/asyncAdapter';
import {
  type AccountTokenPurpose,
  type AccountTokenStore,
  type ConsumedAccountToken,
  type CreateAccountTokenInput,
} from './accountTokenStore';

export class AsyncAccountTokenRepository implements AccountTokenStore {
  constructor(
    private readonly database: AsyncDatabaseAdapter,
    private readonly now: () => Date = () => new Date(),
  ) {}

  create(input: CreateAccountTokenInput): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    const now = this.now();
    const issuedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + input.ttlMs).toISOString();
    return this.database.transaction(async (session) => {
      await session.execute({
        text: `
          UPDATE account_action_tokens SET used_at = COALESCE(used_at, $3)
          WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL;
        `,
        values: [input.userId, input.purpose, issuedAt],
      });
      await session.execute({
        text: `
          INSERT INTO account_action_tokens (
            user_id, purpose, token_hash, payload_json, expires_at
          ) VALUES ($1, $2, $3, $4, $5);
        `,
        values: [
          input.userId,
          input.purpose,
          hashAccountToken(token),
          JSON.stringify(input.payload ?? {}),
          expiresAt,
        ],
      });
      return token;
    });
  }

  async consume(
    token: string,
    purpose: AccountTokenPurpose,
  ): Promise<ConsumedAccountToken | null> {
    if (!token.trim()) return null;
    const now = this.now().toISOString();
    const rows = await this.database.query<{ user_id: number; payload_json: string }>({
      text: `
        UPDATE account_action_tokens SET used_at = $3
        WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL
          AND expires_at > $3
        RETURNING user_id, payload_json;
      `,
      values: [hashAccountToken(token), purpose, now],
    });
    return rows[0] ? {
      userId: Number(rows[0].user_id),
      payload: JSON.parse(rows[0].payload_json) as Record<string, unknown>,
    } : null;
  }
}

function hashAccountToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
