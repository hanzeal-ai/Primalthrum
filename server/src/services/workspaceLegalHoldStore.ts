import {
  type WorkspaceLegalHoldRecord,
} from './workspaceLegalHoldRepository';
import { type Awaitable } from './storeTypes';

export interface CreateWorkspaceLegalHoldInput {
  workspaceId: unknown;
  externalCaseRef: unknown;
  basis: unknown;
  reason: unknown;
  operatorUserId: number;
}

export interface ReleaseWorkspaceLegalHoldInput {
  expectedRevision: unknown;
  releaseReason: unknown;
  operatorUserId: number;
}

export interface WorkspaceLegalHoldStore {
  list(limit?: number): Awaitable<WorkspaceLegalHoldRecord[]>;
  find(id: number): Awaitable<WorkspaceLegalHoldRecord | null>;
  activeCount(workspaceId: number): Awaitable<number>;
  create(input: CreateWorkspaceLegalHoldInput): Awaitable<WorkspaceLegalHoldRecord>;
  release(
    id: unknown,
    input: ReleaseWorkspaceLegalHoldInput,
  ): Awaitable<WorkspaceLegalHoldRecord>;
}
