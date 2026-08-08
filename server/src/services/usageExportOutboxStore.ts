import { type Awaitable } from './storeTypes';
import { type ClaimedUsageExport } from './usageExportOutboxRepository';

export interface UsageExportOutboxStore {
  claimNext(destination: string): Awaitable<ClaimedUsageExport | null>;
  markDelivered(id: number): Awaitable<void>;
  markFailed(id: number, attempts: number, error: string): Awaitable<void>;
  nextAttemptDelayMs(destination: string): Awaitable<number | null>;
}
