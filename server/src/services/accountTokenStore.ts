import { type Awaitable } from './storeTypes';

export type AccountTokenPurpose = 'verify_email' | 'reset_password';

export interface ConsumedAccountToken {
  userId: number;
  payload: Record<string, unknown>;
}

export interface CreateAccountTokenInput {
  userId: number;
  purpose: AccountTokenPurpose;
  ttlMs: number;
  payload?: Record<string, unknown>;
}

export interface AccountTokenStore {
  create(input: CreateAccountTokenInput): Awaitable<string>;
  consume(
    token: string,
    purpose: AccountTokenPurpose,
  ): Awaitable<ConsumedAccountToken | null>;
}
