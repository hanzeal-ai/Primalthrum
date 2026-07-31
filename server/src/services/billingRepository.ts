import { initializeSchema } from '../db/schema';
import { SqliteDatabase } from '../db/sqlite';
import { BillingPlanRepository } from './billingPlanRepository';
import { CreditLedgerRepository } from './creditLedgerRepository';
import { EntitlementRepository } from './entitlementRepository';
import { TrialRepository } from './trialRepository';
import type {
  BillingPlanRecord,
  CreditAccountRecord,
  CreditReservationRecord,
  EntitlementRecord,
  EntitlementSnapshot,
  TrialGrantRecord,
  UsageEventRecord,
} from './billingTypes';

export { BillingError } from './billingTypes';

export class BillingRepository {
  private readonly plans: BillingPlanRepository;
  private readonly entitlements: EntitlementRepository;
  private readonly credits: CreditLedgerRepository;
  private readonly trials: TrialRepository;

  constructor(
    db: SqliteDatabase,
    now: () => Date = () => new Date(),
  ) {
    initializeSchema(db);
    this.plans = new BillingPlanRepository(db);
    this.entitlements = new EntitlementRepository(db, now);
    this.credits = new CreditLedgerRepository(db, now);
    this.trials = new TrialRepository(db, now);
  }

  listPlans(): BillingPlanRecord[] {
    return this.plans.list();
  }

  activateTrial(workspaceId: number, userId: number, planKey = 'pro'): TrialGrantRecord {
    return this.trials.activate(workspaceId, userId, planKey);
  }

  entitlementSnapshot(workspaceId: number): EntitlementSnapshot {
    return this.entitlements.snapshot(workspaceId);
  }

  assertEntitled(
    workspaceId: number,
    feature: string,
    currentUsage = 0,
    requestedQuantity = 1,
  ): EntitlementRecord {
    return this.entitlements.assert(workspaceId, feature, currentUsage, requestedQuantity);
  }

  grantEntitlement(input: Parameters<EntitlementRepository['grant']>[0]): EntitlementSnapshot {
    return this.entitlements.grant(input);
  }

  grantCredits(input: Parameters<CreditLedgerRepository['grant']>[0]): CreditAccountRecord {
    return this.credits.grant(input);
  }

  reserveCredits(input: Parameters<CreditLedgerRepository['reserve']>[0]): CreditReservationRecord {
    return this.credits.reserve(input);
  }

  settleReservation(input: Parameters<CreditLedgerRepository['settle']>[0]): UsageEventRecord {
    return this.credits.settle(input);
  }

  releaseReservation(workspaceId: number, reservationKey: string): CreditReservationRecord {
    return this.credits.release(workspaceId, reservationKey);
  }

  refundUsage(input: Parameters<CreditLedgerRepository['refund']>[0]): CreditAccountRecord {
    return this.credits.refund(input);
  }

  creditAccount(workspaceId: number): CreditAccountRecord {
    return this.credits.account(workspaceId);
  }
}
