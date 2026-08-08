import { type Awaitable } from './storeTypes';
import type {
  BillingPlanRecord,
  CreditAccountRecord,
  CreditReservationRecord,
  EntitlementRecord,
  EntitlementSnapshot,
  TrialGrantRecord,
  UsageEventRecord,
} from './billingTypes';
import {
  type GrantCreditsInput,
  type RefundCreditsInput,
  type ReserveCreditsInput,
  type SettleCreditsInput,
} from './creditLedgerStore';
import { type GrantEntitlementInput } from './entitlementStore';

export interface BillingStore {
  listPlans(): Awaitable<BillingPlanRecord[]>;
  activateTrial(
    workspaceId: number,
    userId: number,
    planKey?: string,
  ): Awaitable<TrialGrantRecord>;
  entitlementSnapshot(workspaceId: number): Awaitable<EntitlementSnapshot>;
  assertEntitled(
    workspaceId: number,
    feature: string,
    currentUsage?: number,
    requestedQuantity?: number,
  ): Awaitable<EntitlementRecord>;
  grantEntitlement(input: GrantEntitlementInput): Awaitable<EntitlementSnapshot>;
  grantCredits(input: GrantCreditsInput): Awaitable<CreditAccountRecord>;
  reserveCredits(input: ReserveCreditsInput): Awaitable<CreditReservationRecord>;
  settleReservation(input: SettleCreditsInput): Awaitable<UsageEventRecord>;
  releaseReservation(
    workspaceId: number,
    reservationKey: string,
  ): Awaitable<CreditReservationRecord>;
  refundUsage(input: RefundCreditsInput): Awaitable<CreditAccountRecord>;
  creditAccount(workspaceId: number): Awaitable<CreditAccountRecord>;
}
