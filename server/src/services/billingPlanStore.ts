import { type Awaitable } from './storeTypes';
import { type BillingPlanRecord } from './billingTypes';

export interface BillingPlanStore {
  list(): Awaitable<BillingPlanRecord[]>;
  find(planKey: string): Awaitable<BillingPlanRecord | null>;
}
