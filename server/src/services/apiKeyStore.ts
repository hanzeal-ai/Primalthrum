import { type Awaitable } from './storeTypes';
import type {
  ApiKeyRecord,
  ApiKeyScope,
  CreatedApiKey,
  ResolvedApiKey,
} from './apiKeyRepository';

export interface CreateApiKeyInput {
  workspaceId: number;
  name: unknown;
  scopes: unknown;
  expiresInDays: unknown;
  createdByUserId: number;
}

export interface ApiKeyStore {
  list(workspaceId: number): Awaitable<ApiKeyRecord[]>;
  create(input: CreateApiKeyInput): Awaitable<CreatedApiKey>;
  resolve(token: string): Awaitable<ResolvedApiKey | null>;
  recordUse(
    apiKeyId: number,
    workspaceId: number,
    method: string,
    path: string,
  ): Awaitable<void>;
  revoke(workspaceId: number, apiKeyId: number): Awaitable<void>;
}

export type { ApiKeyScope };
