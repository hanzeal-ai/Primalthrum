import { type Awaitable } from './storeTypes';
import {
  type CostAlertRecord,
  type CostControlRecord,
  type MeterPriceRecord,
  type RatedUsageRecord,
  type ResourceUsageTotals,
  type UsagePeriodSummary,
  type UsageQuote,
} from './usageRatingTypes';

export interface ConfigureMeterPriceInput {
  pricingVersionKey: string;
  meter: string;
  provider?: string;
  model?: string;
  unitSize: number;
  creditsPerUnit: number;
  providerCostMicrosPerUnit?: number;
}

export interface QuoteUsageInput {
  meter: string;
  quantity: number;
  provider?: string;
  model?: string;
  occurredAt?: string;
}

export interface RateUsageInput extends QuoteUsageInput {
  workspaceId: number;
  idempotencyKey: string;
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  enforceBudget?: boolean;
}

export interface SetCostControlsInput {
  workspaceId: number;
  monthlyCreditLimit?: number | null;
  monthlyProviderCostMicrosLimit?: number | null;
  hardLimit?: boolean;
  overageEnabled?: boolean;
  alertThresholds?: number[];
  updatedByUserId?: number | null;
}

export interface UsageRatingStore {
  configurePrice(input: ConfigureMeterPriceInput): Awaitable<MeterPriceRecord>;
  quote(input: QuoteUsageInput): Awaitable<UsageQuote>;
  rate(input: RateUsageInput): Awaitable<RatedUsageRecord>;
  setControls(input: SetCostControlsInput): Awaitable<CostControlRecord>;
  controls(workspaceId: number): Awaitable<CostControlRecord>;
  listAlerts(workspaceId: number): Awaitable<CostAlertRecord[]>;
  summary(workspaceId: number, at?: Date): Awaitable<UsagePeriodSummary>;
  totalsForResource(
    workspaceId: number,
    resourceType: string,
    resourceId: string,
  ): Awaitable<ResourceUsageTotals>;
  assertProjected(
    workspaceId: number,
    quotes: UsageQuote[],
    occurredAt?: string,
  ): Awaitable<void>;
}
