import {
  type CreateProviderConfigInput,
  type ProviderConfigRecord,
  type UpdateProviderConfigInput,
} from './providerConfigRepository';
import { type Awaitable } from './storeTypes';

export interface ProviderConfigStore {
  create(input: CreateProviderConfigInput, workspaceId: number): Awaitable<ProviderConfigRecord>;
  list(workspaceId: number): Awaitable<ProviderConfigRecord[]>;
  findById(id: number, workspaceId: number): Awaitable<ProviderConfigRecord | null>;
  update(
    id: number,
    input: UpdateProviderConfigInput,
    workspaceId: number,
  ): Awaitable<ProviderConfigRecord | null>;
}
