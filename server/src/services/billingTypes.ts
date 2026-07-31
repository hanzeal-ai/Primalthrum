export interface BillingPlanRecord {
  key: string;
  name: string;
  status: string;
  currency: string;
  monthlyPriceMinor: number;
  monthlyCreditGrant: number;
  trialCreditGrant: number;
  trialDays: number;
  overageEnabled: boolean;
  metadata: Record<string, unknown>;
  entitlements: EntitlementRecord[];
}

export interface EntitlementRecord {
  feature: string;
  enabled: boolean;
  quantityLimit: number | null;
  source: string;
}

export interface EntitlementSnapshot {
  workspaceId: number;
  planKey: string;
  subscriptionState: string;
  generatedAt: string;
  entitlements: Record<string, EntitlementRecord>;
}

export interface CreditAccountRecord {
  workspaceId: number;
  availableCredits: number;
  reservedCredits: number;
  spentCredits: number;
  updatedAt: string;
}

export interface CreditReservationRecord {
  id: number;
  workspaceId: number;
  idempotencyKey: string;
  meter: string;
  reservedCredits: number;
  settledCredits: number | null;
  state: 'reserved' | 'settled' | 'released';
  usageEventId: number | null;
  createdAt: string;
  settledAt: string | null;
  releasedAt: string | null;
}

export interface UsageEventRecord {
  id: number;
  workspaceId: number;
  reservationId: number;
  idempotencyKey: string;
  meter: string;
  quantity: number;
  creditsCharged: number;
  resourceType: string;
  resourceId: string;
  metadata: Record<string, unknown>;
  occurredAt: string;
  createdAt: string;
}

export interface TrialGrantRecord {
  id: number;
  workspaceId: number;
  userId: number;
  planKey: string;
  creditAmount: number;
  startsAt: string;
  endsAt: string;
  createdAt: string;
}

export type BillingErrorCode =
  | 'TRIAL_PLAN_INVALID'
  | 'TRIAL_NOT_ELIGIBLE'
  | 'ENTITLEMENT_REQUIRED'
  | 'ENTITLEMENT_LIMIT_EXCEEDED'
  | 'LEDGER_IDEMPOTENCY_CONFLICT'
  | 'RESERVATION_IDEMPOTENCY_CONFLICT'
  | 'CREDIT_LIMIT_EXCEEDED'
  | 'USAGE_IDEMPOTENCY_CONFLICT'
  | 'RESERVATION_NOT_FOUND'
  | 'RESERVATION_NOT_ACTIVE'
  | 'REFUND_LIMIT_EXCEEDED';

export class BillingError extends Error {
  constructor(readonly code: BillingErrorCode, message: string) {
    super(message);
  }
}
