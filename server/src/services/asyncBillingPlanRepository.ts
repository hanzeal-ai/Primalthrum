import { type AsyncDatabaseAdapter } from '../db/asyncAdapter';
import { type BillingPlanRecord, type EntitlementRecord } from './billingTypes';
import { parseBillingJson } from './billingValidation';

interface PlanRow {
  key: string;
  name: string;
  status: string;
  currency: string;
  monthly_price_minor: number;
  monthly_credit_grant: number;
  trial_credit_grant: number;
  trial_days: number;
  overage_enabled: boolean | number;
  metadata_json: string;
}

interface PlanEntitlementRow {
  plan_key: string;
  feature_key: string;
  enabled: boolean | number;
  quantity_limit: number | null;
}

export class AsyncBillingPlanRepository {
  constructor(private readonly database: AsyncDatabaseAdapter) {}

  async list(): Promise<BillingPlanRecord[]> {
    const [plans, entitlementRows] = await Promise.all([
      this.database.query<PlanRow>({
        text: `
          SELECT key, name, status, currency, monthly_price_minor,
            monthly_credit_grant, trial_credit_grant, trial_days,
            overage_enabled, metadata_json
          FROM billing_plans WHERE status = 'active';
        `,
      }),
      this.database.query<PlanEntitlementRow>({
        text: `
          SELECT plan_key, feature_key, enabled, quantity_limit
          FROM plan_entitlements ORDER BY plan_key, feature_key;
        `,
      }),
    ]);
    const entitlements = groupEntitlements(entitlementRows);
    return plans.map((plan) => mapPlan(plan, entitlements.get(plan.key) ?? []))
      .sort((left, right) => (
        planPosition(left) - planPosition(right) || left.key.localeCompare(right.key)
      ));
  }

  async find(planKey: string): Promise<BillingPlanRecord | null> {
    return (await this.list()).find((plan) => plan.key === planKey) ?? null;
  }
}

function groupEntitlements(
  rows: PlanEntitlementRow[],
): Map<string, EntitlementRecord[]> {
  const grouped = new Map<string, EntitlementRecord[]>();
  for (const row of rows) {
    const values = grouped.get(row.plan_key) ?? [];
    values.push({
      feature: row.feature_key,
      enabled: Boolean(row.enabled),
      quantityLimit: row.quantity_limit === null ? null : Number(row.quantity_limit),
      source: `plan:${row.plan_key}`,
    });
    grouped.set(row.plan_key, values);
  }
  return grouped;
}

function mapPlan(plan: PlanRow, entitlements: EntitlementRecord[]): BillingPlanRecord {
  return {
    key: plan.key,
    name: plan.name,
    status: plan.status,
    currency: plan.currency,
    monthlyPriceMinor: Number(plan.monthly_price_minor),
    monthlyCreditGrant: Number(plan.monthly_credit_grant),
    trialCreditGrant: Number(plan.trial_credit_grant),
    trialDays: Number(plan.trial_days),
    overageEnabled: Boolean(plan.overage_enabled),
    metadata: parseBillingJson(plan.metadata_json),
    entitlements,
  };
}

function planPosition(plan: BillingPlanRecord): number {
  const value = Number(plan.metadata.position);
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}
