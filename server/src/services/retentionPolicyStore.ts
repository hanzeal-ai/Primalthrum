import {
  type RetentionEventRecord,
  type RetentionFileDeletionRecord,
  type RetentionPolicyRecord,
  type RetentionPolicySnapshot,
  type RetentionPreview,
} from './retentionPolicyRepository';
import { type Awaitable } from './storeTypes';

export interface UpdateRetentionPolicyInput {
  workspaceId: number;
  conversationDays: unknown;
  runDays: unknown;
  documentDays: unknown;
  actorUserId: number;
}

export interface RetentionPolicyStore {
  get(workspaceId: number): Awaitable<RetentionPolicyRecord>;
  update(input: UpdateRetentionPolicyInput): Awaitable<RetentionPolicyRecord>;
  preview(workspaceId: number): Awaitable<RetentionPreview>;
  previewPolicy(
    workspaceId: number,
    policy: RetentionPolicySnapshot,
  ): Awaitable<RetentionPreview>;
  enforce(workspaceId: number, actorUserId: number | null): Awaitable<RetentionEventRecord>;
  listEvents(workspaceId: number, limit?: number): Awaitable<RetentionEventRecord[]>;
  dueWorkspaceIds(): Awaitable<number[]>;
  pendingFileDeletions(
    workspaceId: number,
    limit?: number,
  ): Awaitable<RetentionFileDeletionRecord[]>;
  hasActiveLegalHold(workspaceId: number): Awaitable<boolean>;
  completeFileDeletion(id: number): Awaitable<void>;
  failFileDeletion(id: number, attempts: number, error: string): Awaitable<void>;
}
