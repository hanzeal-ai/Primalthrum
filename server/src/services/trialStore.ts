import { type Awaitable } from './storeTypes';
import { type TrialGrantRecord } from './billingTypes';

export interface TrialStore {
  activate(
    workspaceId: number,
    userId: number,
    planKey?: string,
  ): Awaitable<TrialGrantRecord>;
}
