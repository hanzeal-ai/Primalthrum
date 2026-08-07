import { type CreateRunInput, type RunRecord } from './runRepository';
import { type Awaitable } from './storeTypes';

export interface RunStore {
  create(input: CreateRunInput): Awaitable<RunRecord>;
  findById(id: number): Awaitable<RunRecord | null>;
  findByIdInWorkspace(id: number, workspaceId: number): Awaitable<RunRecord | null>;
  findByIdempotencyKey(
    workspaceId: number,
    idempotencyKey: string,
  ): Awaitable<RunRecord | null>;
  attachConversation(id: number, conversationId: number): Awaitable<RunRecord>;
  updateStatus(id: number, status: string, endedAt?: string | null): Awaitable<RunRecord>;
}
