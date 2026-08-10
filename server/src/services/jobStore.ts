import {
  type CreateJobInput,
  type JobRecord,
} from './jobRepository';
import { type Awaitable } from './storeTypes';

export const DEFAULT_JOB_LEASE_DURATION_MS = 5 * 60_000;

export interface JobRepositoryOptions {
  leaseDurationMs?: number;
  leaseOwner?: string;
}

export interface CreateUniqueJobInput extends CreateJobInput {
  dedupeKey: string;
}

export interface JobStore {
  create(input: CreateJobInput): Awaitable<JobRecord>;
  createUnique(input: CreateUniqueJobInput): Awaitable<JobRecord | null>;
  findById(id: number): Awaitable<JobRecord | null>;
  findByIdInWorkspace(id: number, workspaceId: number): Awaitable<JobRecord | null>;
  nextRunnable(types: string[]): Awaitable<JobRecord | null>;
  claimNext(types: string[]): Awaitable<JobRecord | null>;
  recoverInterrupted(types: string[]): Awaitable<void>;
  renewLease(id: number): Awaitable<boolean>;
  markRunning(id: number): Awaitable<JobRecord>;
  markSucceeded(id: number, result: Record<string, unknown>): Awaitable<JobRecord>;
  markFailed(id: number, error: string): Awaitable<JobRecord>;
}
