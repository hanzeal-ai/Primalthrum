import { type DatabaseAdapter } from '../db/adapter';
import { sqlValue } from '../db/sql';
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
  overage_enabled: number;
  metadata_json: string;
}

interface PlanEntitlementRow {
  feature_key: string;
  enabled: number;
  quantity_limit: number | null;
  source: string;
}

export class BillingPlanRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  list(): BillingPlanRecord[] {
    return this.db.query<PlanRow>(`
      SELECT key, name, status, currency, monthly_price_minor,
        monthly_credit_grant, trial_credit_grant, trial_days,
        overage_enabled, metadata_json
      FROM billing_plans
      WHERE status = 'active'
      ORDER BY CAST(json_extract(metadata_json, '$.position') AS INTEGER), key;
    `).map((plan) => ({
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
      entitlements: this.entitlements(plan.key),
    }));
  }

  find(planKey: string): BillingPlanRecord | null {
    return this.list().find((plan) => plan.key === planKey) ?? null;
  }

  private entitlements(planKey: string): EntitlementRecord[] {
    return this.db.query<PlanEntitlementRow>(`
      SELECT feature_key, enabled, quantity_limit,
        'plan:' || plan_key AS source
      FROM plan_entitlements
      WHERE plan_key = ${sqlValue(planKey)}
      ORDER BY feature_key;
    `).map((row) => ({
      feature: row.feature_key,
      enabled: Boolean(row.enabled),
      quantityLimit: row.quantity_limit === null ? null : Number(row.quantity_limit),
      source: row.source,
    }));
  }
}
