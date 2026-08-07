import { type Awaitable } from './storeTypes';

export interface SecretStore {
  create(plaintext: string, workspaceId: number): Awaitable<string>;
  update(secretRef: string, plaintext: string, workspaceId: number): Awaitable<void>;
  read(secretRef: string, workspaceId: number): Awaitable<string>;
  delete(secretRef: string, workspaceId: number): Awaitable<void>;
}
