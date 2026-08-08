import { type AsyncDatabaseAdapter } from '../db/asyncAdapter';
import { AsyncBillingPlanRepository } from './asyncBillingPlanRepository';
import { AsyncCreditLedgerRepository } from './asyncCreditLedgerRepository';
import { AsyncEntitlementRepository } from './asyncEntitlementRepository';
import { AsyncTrialRepository } from './asyncTrialRepository';
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

export class AsyncBillingRepository {
  private readonly plans: AsyncBillingPlanRepository;
  private readonly entitlements: AsyncEntitlementRepository;
  private readonly credits: AsyncCreditLedgerRepository;
  private readonly trials: AsyncTrialRepository;

  constructor(database: AsyncDatabaseAdapter, now: () => Date = () => new Date()) {
    this.plans = new AsyncBillingPlanRepository(database);
    this.entitlements = new AsyncEntitlementRepository(database, now);
    this.credits = new AsyncCreditLedgerRepository(database, now);
    this.trials = new AsyncTrialRepository(database, now);
  }

  listPlans(): Promise<BillingPlanRecord[]> {
    return this.plans.list();
  }

  activateTrial(
    workspaceId: number,
    userId: number,
    planKey = 'pro',
  ): Promise<TrialGrantRecord> {
    return this.trials.activate(workspaceId, userId, planKey);
  }

  entitlementSnapshot(workspaceId: number): Promise<EntitlementSnapshot> {
    return this.entitlements.snapshot(workspaceId);
  }

  assertEntitled(
    workspaceId: number,
    feature: string,
    currentUsage = 0,
    requestedQuantity = 1,
  ): Promise<EntitlementRecord> {
    return this.entitlements.assert(workspaceId, feature, currentUsage, requestedQuantity);
  }

  grantEntitlement(input: GrantEntitlementInput): Promise<EntitlementSnapshot> {
    return this.entitlements.grant(input);
  }

  grantCredits(input: GrantCreditsInput): Promise<CreditAccountRecord> {
    return this.credits.grant(input);
  }

  reserveCredits(input: ReserveCreditsInput): Promise<CreditReservationRecord> {
    return this.credits.reserve(input);
  }

  settleReservation(input: SettleCreditsInput): Promise<UsageEventRecord> {
    return this.credits.settle(input);
  }

  releaseReservation(
    workspaceId: number,
    reservationKey: string,
  ): Promise<CreditReservationRecord> {
    return this.credits.release(workspaceId, reservationKey);
  }

  refundUsage(input: RefundCreditsInput): Promise<CreditAccountRecord> {
    return this.credits.refund(input);
  }

  creditAccount(workspaceId: number): Promise<CreditAccountRecord> {
    return this.credits.account(workspaceId);
  }
}
