import { initializeSchema } from '../db/schema';
import { SqliteDatabase, sqlValue } from '../db/sqlite';
import {
  type CostControlRecord,
  type CostAlertRecord,
  type MeterPriceRecord,
  type RatedUsageRecord,
  type ResourceUsageTotals,
  type UsageQuote,
  type UsagePeriodSummary,
  UsageRatingError,
} from './usageRatingTypes';

interface PriceRow {
  id: number;
  pricing_version_key: string;
  meter: string;
  provider: string;
  model: string;
  unit_size: number;
  credits_per_unit: number;
  provider_cost_micros_per_unit: number;
}

interface UsageRow {
  id: number;
  workspace_id: number;
  idempotency_key: string;
  meter: string;
  provider: string;
  model: string;
  quantity: number;
  billable_units: number;
  credits_charged: number;
  provider_cost_micros: number;
  meter_price_id: number;
  resource_type: string;
  resource_id: string;
  metadata_json: string;
  occurred_at: string;
  created_at: string;
}

interface ControlRow {
  workspace_id: number;
  monthly_credit_limit: number | null;
  monthly_provider_cost_micros_limit: number | null;
  hard_limit: number;
  overage_enabled: number;
  alert_thresholds_json: string;
}

export class UsageRatingRepository {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {
    initializeSchema(db);
  }

  configurePrice(input: {
    pricingVersionKey: string;
    meter: string;
    provider?: string;
    model?: string;
    unitSize: number;
    creditsPerUnit: number;
    providerCostMicrosPerUnit?: number;
  }): MeterPriceRecord {
    validateNonNegativeInteger(input.creditsPerUnit, 'creditsPerUnit');
    validateNonNegativeInteger(input.providerCostMicrosPerUnit ?? 0, 'providerCostMicrosPerUnit');
    if (!Number.isSafeInteger(input.unitSize) || input.unitSize <= 0) {
      throw new Error('unitSize must be a positive integer');
    }
    this.db.run(`
      INSERT INTO meter_prices (
        pricing_version_key, meter, provider, model, unit_size,
        credits_per_unit, provider_cost_micros_per_unit
      ) VALUES (
        ${sqlValue(input.pricingVersionKey)}, ${sqlValue(input.meter)},
        ${sqlValue(input.provider ?? '*')}, ${sqlValue(input.model ?? '*')},
        ${sqlValue(input.unitSize)}, ${sqlValue(input.creditsPerUnit)},
        ${sqlValue(input.providerCostMicrosPerUnit ?? 0)}
      ) ON CONFLICT(pricing_version_key, meter, provider, model) DO UPDATE SET
        unit_size = excluded.unit_size,
        credits_per_unit = excluded.credits_per_unit,
        provider_cost_micros_per_unit = excluded.provider_cost_micros_per_unit,
        active = 1,
        updated_at = CURRENT_TIMESTAMP;
    `);
    const price = this.findPrice(
      input.meter,
      input.provider ?? '',
      input.model ?? '',
      this.now().toISOString(),
    );
    if (!price) throw new Error('configured meter price could not be loaded');
    return price;
  }

  quote(input: {
    meter: string;
    quantity: number;
    provider?: string;
    model?: string;
    occurredAt?: string;
  }): UsageQuote {
    validateNonNegativeInteger(input.quantity, 'quantity');
    const meter = normalizeUsageKey(input.meter, 'meter');
    const occurredAt = normalizeTimestamp(input.occurredAt ?? this.now().toISOString());
    const price = this.findPrice(
      meter,
      input.provider?.trim() ?? '',
      input.model?.trim() ?? '',
      occurredAt,
    );
    if (!price) {
      throw new UsageRatingError('METER_PRICE_NOT_FOUND', `no active price for meter ${meter}`);
    }
    const billableUnits = input.quantity === 0 ? 0 : Math.ceil(input.quantity / price.unitSize);
    return {
      meterPriceId: price.id,
      meter,
      quantity: input.quantity,
      billableUnits,
      credits: billableUnits * price.creditsPerUnit,
      providerCostMicros: billableUnits * price.providerCostMicrosPerUnit,
    };
  }

  rate(input: {
    workspaceId: number;
    idempotencyKey: string;
    meter: string;
    quantity: number;
    provider?: string;
    model?: string;
    resourceType?: string;
    resourceId?: string;
    metadata?: Record<string, unknown>;
    occurredAt?: string;
    enforceBudget?: boolean;
  }): RatedUsageRecord {
    validateNonNegativeInteger(input.quantity, 'quantity');
    const idempotencyKey = normalizeUsageKey(input.idempotencyKey, 'idempotencyKey');
    const meter = normalizeUsageKey(input.meter, 'meter');
    const occurredAt = normalizeTimestamp(input.occurredAt ?? this.now().toISOString());
    const existing = this.findByKey(input.workspaceId, idempotencyKey);
    if (existing) return validateReplay(existing, input, occurredAt, input.occurredAt !== undefined);
    const provider = input.provider?.trim() ?? '';
    const model = input.model?.trim() ?? '';
    const quote = this.quote({ meter, provider, model, quantity: input.quantity, occurredAt });
    const billableUnits = quote.billableUnits;
    const credits = quote.credits;
    const providerCostMicros = quote.providerCostMicros;
    if (input.enforceBudget !== false) {
      this.assertWithinBudget(input.workspaceId, credits, providerCostMicros, occurredAt);
    }
    this.db.run(`
      INSERT INTO rated_usage_events (
        workspace_id, idempotency_key, meter, provider, model, quantity,
        billable_units, credits_charged, provider_cost_micros, meter_price_id,
        resource_type, resource_id, metadata_json, occurred_at
      ) VALUES (
        ${sqlValue(input.workspaceId)}, ${sqlValue(idempotencyKey)},
        ${sqlValue(meter)}, ${sqlValue(provider)}, ${sqlValue(model)},
        ${sqlValue(input.quantity)}, ${sqlValue(billableUnits)}, ${sqlValue(credits)},
        ${sqlValue(providerCostMicros)}, ${sqlValue(quote.meterPriceId)},
        ${sqlValue(input.resourceType ?? '')}, ${sqlValue(input.resourceId ?? '')},
        ${sqlValue(JSON.stringify(input.metadata ?? {}))}, ${sqlValue(occurredAt)}
      );
    `);
    this.createThresholdAlerts(input.workspaceId, occurredAt);
    const created = this.findByKey(input.workspaceId, idempotencyKey);
    if (!created) throw new Error('rated usage event could not be loaded');
    return created;
  }

  setControls(input: {
    workspaceId: number;
    monthlyCreditLimit?: number | null;
    monthlyProviderCostMicrosLimit?: number | null;
    hardLimit?: boolean;
    overageEnabled?: boolean;
    alertThresholds?: number[];
    updatedByUserId?: number | null;
  }): CostControlRecord {
    validateNullableNonNegativeInteger(input.monthlyCreditLimit, 'monthlyCreditLimit');
    validateNullableNonNegativeInteger(
      input.monthlyProviderCostMicrosLimit,
      'monthlyProviderCostMicrosLimit',
    );
    const thresholds = normalizeThresholds(input.alertThresholds ?? [50, 80, 100]);
    this.db.run(`
      INSERT INTO workspace_cost_controls (
        workspace_id, monthly_credit_limit, monthly_provider_cost_micros_limit,
        hard_limit, overage_enabled, alert_thresholds_json, updated_by_user_id
      ) VALUES (
        ${sqlValue(input.workspaceId)}, ${sqlValue(input.monthlyCreditLimit ?? null)},
        ${sqlValue(input.monthlyProviderCostMicrosLimit ?? null)},
        ${input.hardLimit === false ? 0 : 1}, ${input.overageEnabled ? 1 : 0},
        ${sqlValue(JSON.stringify(thresholds))}, ${sqlValue(input.updatedByUserId ?? null)}
      ) ON CONFLICT(workspace_id) DO UPDATE SET
        monthly_credit_limit = excluded.monthly_credit_limit,
        monthly_provider_cost_micros_limit = excluded.monthly_provider_cost_micros_limit,
        hard_limit = excluded.hard_limit,
        overage_enabled = excluded.overage_enabled,
        alert_thresholds_json = excluded.alert_thresholds_json,
        updated_by_user_id = excluded.updated_by_user_id,
        updated_at = CURRENT_TIMESTAMP;
    `);
    return this.controls(input.workspaceId);
  }

  controls(workspaceId: number): CostControlRecord {
    const row = this.db.query<ControlRow>(`
      SELECT workspace_id, monthly_credit_limit,
        monthly_provider_cost_micros_limit, hard_limit, overage_enabled,
        alert_thresholds_json
      FROM workspace_cost_controls
      WHERE workspace_id = ${sqlValue(workspaceId)}
      LIMIT 1;
    `)[0];
    return row ? mapControl(row) : {
      workspaceId,
      monthlyCreditLimit: null,
      monthlyProviderCostMicrosLimit: null,
      hardLimit: true,
      overageEnabled: false,
      alertThresholds: [50, 80, 100],
    };
  }

  listAlerts(workspaceId: number): CostAlertRecord[] {
    return this.db.query<{
      id: number;
      workspace_id: number;
      period_key: string;
      threshold_percent: number;
      metric: string;
      current_value: number;
      limit_value: number;
      status: string;
      created_at: string;
      delivered_at: string | null;
    }>(`
      SELECT id, workspace_id, period_key, threshold_percent, metric,
        current_value, limit_value, status, created_at, delivered_at
      FROM cost_alerts
      WHERE workspace_id = ${sqlValue(workspaceId)}
      ORDER BY created_at DESC, id DESC;
    `).map((row) => ({
      id: Number(row.id),
      workspaceId: Number(row.workspace_id),
      periodKey: row.period_key,
      thresholdPercent: Number(row.threshold_percent),
      metric: row.metric,
      currentValue: Number(row.current_value),
      limitValue: Number(row.limit_value),
      status: row.status,
      createdAt: row.created_at,
      deliveredAt: row.delivered_at,
    }));
  }

  summary(workspaceId: number, at = this.now()): UsagePeriodSummary {
    const period = monthPeriod(at);
    const rows = this.db.query<{
      meter: string;
      quantity: number;
      credits: number;
      cost: number;
      count: number;
    }>(`
      SELECT meter, SUM(quantity) AS quantity, SUM(credits_charged) AS credits,
        SUM(provider_cost_micros) AS cost, COUNT(*) AS count
      FROM rated_usage_events
      WHERE workspace_id = ${sqlValue(workspaceId)}
        AND occurred_at >= ${sqlValue(period.start)}
        AND occurred_at < ${sqlValue(period.end)}
      GROUP BY meter
      ORDER BY meter;
    `);
    return {
      workspaceId,
      periodStartsAt: period.start,
      periodEndsAt: period.end,
      creditsCharged: rows.reduce((sum, row) => sum + Number(row.credits), 0),
      providerCostMicros: rows.reduce((sum, row) => sum + Number(row.cost), 0),
      eventCount: rows.reduce((sum, row) => sum + Number(row.count), 0),
      byMeter: rows.map((row) => ({
        meter: row.meter,
        quantity: Number(row.quantity),
        creditsCharged: Number(row.credits),
        providerCostMicros: Number(row.cost),
      })),
      controls: this.controls(workspaceId),
    };
  }

  totalsForResource(
    workspaceId: number,
    resourceType: string,
    resourceId: string,
  ): ResourceUsageTotals {
    const row = this.db.query<{
      event_count: number;
      quantity: number;
      credits: number;
      cost: number;
    }>(`
      SELECT COUNT(*) AS event_count, COALESCE(SUM(quantity), 0) AS quantity,
        COALESCE(SUM(credits_charged), 0) AS credits,
        COALESCE(SUM(provider_cost_micros), 0) AS cost
      FROM rated_usage_events
      WHERE workspace_id = ${sqlValue(workspaceId)}
        AND resource_type = ${sqlValue(resourceType)}
        AND resource_id = ${sqlValue(resourceId)};
    `)[0];
    return {
      eventCount: Number(row?.event_count ?? 0),
      quantity: Number(row?.quantity ?? 0),
      credits: Number(row?.credits ?? 0),
      providerCostMicros: Number(row?.cost ?? 0),
    };
  }

  assertProjected(
    workspaceId: number,
    quotes: UsageQuote[],
    occurredAt = this.now().toISOString(),
  ): void {
    this.assertWithinBudget(
      workspaceId,
      quotes.reduce((sum, quote) => sum + quote.credits, 0),
      quotes.reduce((sum, quote) => sum + quote.providerCostMicros, 0),
      normalizeTimestamp(occurredAt),
    );
  }

  private findPrice(
    meter: string,
    provider: string,
    model: string,
    occurredAt: string,
  ): MeterPriceRecord | null {
    const row = this.db.query<PriceRow>(`
      SELECT mp.id, mp.pricing_version_key, mp.meter, mp.provider, mp.model,
        mp.unit_size, mp.credits_per_unit, mp.provider_cost_micros_per_unit
      FROM meter_prices mp
      JOIN pricing_versions pv ON pv.key = mp.pricing_version_key
      WHERE mp.meter = ${sqlValue(meter)} AND mp.active = 1
        AND pv.status = 'active'
        AND pv.effective_from <= ${sqlValue(occurredAt)}
        AND (pv.effective_to IS NULL OR pv.effective_to > ${sqlValue(occurredAt)})
        AND mp.provider IN ('*', ${sqlValue(provider)})
        AND mp.model IN ('*', ${sqlValue(model)})
      ORDER BY (mp.provider = ${sqlValue(provider)}) DESC,
        (mp.model = ${sqlValue(model)}) DESC, pv.effective_from DESC, mp.id DESC
      LIMIT 1;
    `)[0];
    return row ? mapPrice(row) : null;
  }

  private findByKey(workspaceId: number, key: string): RatedUsageRecord | null {
    const row = this.db.query<UsageRow>(`
      SELECT id, workspace_id, idempotency_key, meter, provider, model,
        quantity, billable_units, credits_charged, provider_cost_micros,
        meter_price_id, resource_type, resource_id, metadata_json,
        occurred_at, created_at
      FROM rated_usage_events
      WHERE workspace_id = ${sqlValue(workspaceId)}
        AND idempotency_key = ${sqlValue(key)}
      LIMIT 1;
    `)[0];
    return row ? mapUsage(row) : null;
  }

  private assertWithinBudget(
    workspaceId: number,
    projectedCredits: number,
    projectedCost: number,
    occurredAt: string,
  ): void {
    const controls = this.controls(workspaceId);
    if (!controls.hardLimit || controls.overageEnabled) return;
    const summary = this.summary(workspaceId, new Date(occurredAt));
    if (
      controls.monthlyCreditLimit !== null
      && summary.creditsCharged + projectedCredits > controls.monthlyCreditLimit
    ) {
      throw new UsageRatingError(
        'MONTHLY_CREDIT_LIMIT_EXCEEDED',
        'workspace monthly credit limit exceeded',
      );
    }
    if (
      controls.monthlyProviderCostMicrosLimit !== null
      && summary.providerCostMicros + projectedCost > controls.monthlyProviderCostMicrosLimit
    ) {
      throw new UsageRatingError(
        'MONTHLY_COST_LIMIT_EXCEEDED',
        'workspace monthly provider cost limit exceeded',
      );
    }
  }

  private createThresholdAlerts(workspaceId: number, occurredAt: string): void {
    const summary = this.summary(workspaceId, new Date(occurredAt));
    const controls = summary.controls;
    const periodKey = summary.periodStartsAt.slice(0, 7);
    for (const threshold of controls.alertThresholds) {
      this.createAlert(
        workspaceId,
        periodKey,
        threshold,
        'credits',
        summary.creditsCharged,
        controls.monthlyCreditLimit,
      );
      this.createAlert(
        workspaceId,
        periodKey,
        threshold,
        'provider_cost_micros',
        summary.providerCostMicros,
        controls.monthlyProviderCostMicrosLimit,
      );
    }
  }

  private createAlert(
    workspaceId: number,
    periodKey: string,
    threshold: number,
    metric: string,
    current: number,
    limit: number | null,
  ): void {
    if (limit === null || current * 100 < limit * threshold) return;
    this.db.run(`
      INSERT OR IGNORE INTO cost_alerts (
        workspace_id, period_key, threshold_percent, metric,
        current_value, limit_value
      ) VALUES (
        ${sqlValue(workspaceId)}, ${sqlValue(periodKey)}, ${sqlValue(threshold)},
        ${sqlValue(metric)}, ${sqlValue(current)}, ${sqlValue(limit)}
      );
    `);
  }
}

function mapPrice(row: PriceRow): MeterPriceRecord {
  return {
    id: Number(row.id),
    pricingVersionKey: row.pricing_version_key,
    meter: row.meter,
    provider: row.provider,
    model: row.model,
    unitSize: Number(row.unit_size),
    creditsPerUnit: Number(row.credits_per_unit),
    providerCostMicrosPerUnit: Number(row.provider_cost_micros_per_unit),
  };
}

function mapUsage(row: UsageRow): RatedUsageRecord {
  return {
    id: Number(row.id),
    workspaceId: Number(row.workspace_id),
    idempotencyKey: row.idempotency_key,
    meter: row.meter,
    provider: row.provider,
    model: row.model,
    quantity: Number(row.quantity),
    billableUnits: Number(row.billable_units),
    creditsCharged: Number(row.credits_charged),
    providerCostMicros: Number(row.provider_cost_micros),
    meterPriceId: Number(row.meter_price_id),
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  };
}

function mapControl(row: ControlRow): CostControlRecord {
  return {
    workspaceId: Number(row.workspace_id),
    monthlyCreditLimit: row.monthly_credit_limit === null
      ? null
      : Number(row.monthly_credit_limit),
    monthlyProviderCostMicrosLimit: row.monthly_provider_cost_micros_limit === null
      ? null
      : Number(row.monthly_provider_cost_micros_limit),
    hardLimit: Boolean(row.hard_limit),
    overageEnabled: Boolean(row.overage_enabled),
    alertThresholds: normalizeThresholds(JSON.parse(row.alert_thresholds_json) as number[]),
  };
}

function validateReplay(
  existing: RatedUsageRecord,
  input: { meter: string; quantity: number; provider?: string; model?: string },
  occurredAt: string,
  compareOccurredAt: boolean,
): RatedUsageRecord {
  if (
    existing.meter !== input.meter
    || existing.quantity !== input.quantity
    || existing.provider !== (input.provider?.trim() ?? '')
    || existing.model !== (input.model?.trim() ?? '')
    || (compareOccurredAt && existing.occurredAt !== occurredAt)
  ) {
    throw new UsageRatingError(
      'USAGE_IDEMPOTENCY_CONFLICT',
      'usage idempotency key was reused with different evidence',
    );
  }
  return existing;
}

function validateNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be non-negative`);
}

function validateNullableNonNegativeInteger(value: number | null | undefined, label: string): void {
  if (value === undefined || value === null) return;
  validateNonNegativeInteger(value, label);
}

function normalizeTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('occurredAt must be an ISO timestamp');
  return date.toISOString();
}

function normalizeUsageKey(value: string, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error(`${label} has an invalid format`);
  }
  return value;
}

function normalizeThresholds(values: number[]): number[] {
  const unique = [...new Set(values.map(Number))].sort((left, right) => left - right);
  if (!unique.length || unique.some((value) => !Number.isInteger(value) || value <= 0 || value > 100)) {
    throw new Error('alert thresholds must be integers between 1 and 100');
  }
  return unique;
}

function monthPeriod(date: Date): { start: string; end: string } {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}
