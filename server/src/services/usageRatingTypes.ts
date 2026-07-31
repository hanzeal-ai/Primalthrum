export interface MeterPriceRecord {
  id: number;
  pricingVersionKey: string;
  meter: string;
  provider: string;
  model: string;
  unitSize: number;
  creditsPerUnit: number;
  providerCostMicrosPerUnit: number;
}

export interface RatedUsageRecord {
  id: number;
  workspaceId: number;
  idempotencyKey: string;
  meter: string;
  provider: string;
  model: string;
  quantity: number;
  billableUnits: number;
  creditsCharged: number;
  providerCostMicros: number;
  meterPriceId: number;
  resourceType: string;
  resourceId: string;
  metadata: Record<string, unknown>;
  occurredAt: string;
  createdAt: string;
}

export interface UsageQuote {
  meterPriceId: number;
  meter: string;
  quantity: number;
  billableUnits: number;
  credits: number;
  providerCostMicros: number;
}

export interface ResourceUsageTotals {
  eventCount: number;
  quantity: number;
  credits: number;
  providerCostMicros: number;
}

export interface CostControlRecord {
  workspaceId: number;
  monthlyCreditLimit: number | null;
  monthlyProviderCostMicrosLimit: number | null;
  hardLimit: boolean;
  overageEnabled: boolean;
  alertThresholds: number[];
}

export interface UsagePeriodSummary {
  workspaceId: number;
  periodStartsAt: string;
  periodEndsAt: string;
  creditsCharged: number;
  providerCostMicros: number;
  eventCount: number;
  byMeter: Array<{
    meter: string;
    quantity: number;
    creditsCharged: number;
    providerCostMicros: number;
  }>;
  controls: CostControlRecord;
}

export class UsageRatingError extends Error {
  constructor(
    readonly code:
      | 'METER_PRICE_NOT_FOUND'
      | 'USAGE_IDEMPOTENCY_CONFLICT'
      | 'MONTHLY_CREDIT_LIMIT_EXCEEDED'
      | 'MONTHLY_COST_LIMIT_EXCEEDED',
    message: string,
  ) {
    super(message);
  }
}
