import { type Awaitable } from './storeTypes';
import { type BillingPlanRecord, type CreditAccountRecord } from './billingTypes';
import { type GrantCreditsInput } from './creditLedgerStore';

export interface PaymentBillingStore {
  listPlans(): Awaitable<BillingPlanRecord[]>;
  grantCredits(input: GrantCreditsInput): Awaitable<CreditAccountRecord>;
}
