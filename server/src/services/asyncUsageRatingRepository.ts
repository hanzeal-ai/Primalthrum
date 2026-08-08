import {
  type AsyncDatabaseAdapter,
  type AsyncDatabaseSession,
} from '../db/asyncAdapter';
import { databaseTimestamp, nullableDatabaseTimestamp } from '../db/databaseTimestamp';
import {
  type ConfigureMeterPriceInput,
  type QuoteUsageInput,
  type RateUsageInput,
  type SetCostControlsInput,
} from './usageRatingStore';
import {
  type CostAlertRecord,
  type CostControlRecord,
  type MeterPriceRecord,
  type RatedUsageRecord,
  type ResourceUsageTotals,
  type UsagePeriodSummary,
  type UsageQuote,
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
  occurred_at: string | Date;
  created_at: string | Date;
}

interface ControlRow {
  workspace_id: number;
  monthly_credit_limit: number | null;
  monthly_provider_cost_micros_limit: number | null;
  hard_limit: boolean | number;
  overage_enabled: boolean | number;
  alert_thresholds_json: string;
}

interface SummaryRow {
  meter: string;
  quantity: number | string;
  credits: number | string;
  cost: number | string;
  count: number | string;
}

const USAGE_COLUMNS = [
  'id', 'workspace_id', 'idempotency_key', 'meter', 'provider', 'model',
  'quantity', 'billable_units', 'credits_charged', 'provider_cost_micros',
  'meter_price_id', 'resource_type', 'resource_id', 'metadata_json',
  'occurred_at', 'created_at',
].join(', ');

export class AsyncUsageRatingRepository {
  constructor(
    private readonly database: AsyncDatabaseAdapter,
    private readonly now: () => Date = () => new Date(),
    private readonly onUsageRated?: () => void,
  ) {}

  async configurePrice(input: ConfigureMeterPriceInput): Promise<MeterPriceRecord> {
    validateNonNegativeInteger(input.creditsPerUnit, 'creditsPerUnit');
    validateNonNegativeInteger(input.providerCostMicrosPerUnit ?? 0, 'providerCostMicrosPerUnit');
    if (!Number.isSafeInteger(input.unitSize) || input.unitSize <= 0) {
      throw new Error('unitSize must be a positive integer');
    }
    const price = await this.database.transaction(async (session) => {
      await session.execute({
        text: `
          INSERT INTO meter_prices (
            pricing_version_key, meter, provider, model, unit_size,
            credits_per_unit, provider_cost_micros_per_unit
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT(pricing_version_key, meter, provider, model) DO UPDATE SET
            unit_size = excluded.unit_size,
            credits_per_unit = excluded.credits_per_unit,
            provider_cost_micros_per_unit = excluded.provider_cost_micros_per_unit,
            active = TRUE,
            updated_at = CURRENT_TIMESTAMP;
        `,
        values: [
          input.pricingVersionKey,
          normalizeUsageKey(input.meter, 'meter'),
          input.provider?.trim() || '*',
          input.model?.trim() || '*',
          input.unitSize,
          input.creditsPerUnit,
          input.providerCostMicrosPerUnit ?? 0,
        ],
      });
      return this.findPrice(
        session,
        input.meter,
        input.provider?.trim() ?? '',
        input.model?.trim() ?? '',
        this.now().toISOString(),
      );
    });
    if (!price) throw new Error('configured meter price could not be loaded');
    return price;
  }

  quote(input: QuoteUsageInput): Promise<UsageQuote> {
    return this.quoteWith(this.database, input);
  }

  async rate(input: RateUsageInput): Promise<RatedUsageRecord> {
    validateNonNegativeInteger(input.quantity, 'quantity');
    const idempotencyKey = normalizeUsageKey(input.idempotencyKey, 'idempotencyKey');
    const meter = normalizeUsageKey(input.meter, 'meter');
    const occurredAt = normalizeTimestamp(input.occurredAt ?? this.now().toISOString());
    const result = await this.database.transaction(async (session) => {
      await this.lockWorkspace(session, input.workspaceId);
      const existing = await this.findByKey(session, input.workspaceId, idempotencyKey);
      if (existing) {
        return {
          record: validateReplay(existing, input, occurredAt, input.occurredAt !== undefined),
          created: false,
        };
      }
      const provider = input.provider?.trim() ?? '';
      const model = input.model?.trim() ?? '';
      const quote = await this.quoteWith(session, {
        meter,
        provider,
        model,
        quantity: input.quantity,
        occurredAt,
      });
      if (input.enforceBudget !== false) {
        await this.assertWithinBudget(
          session,
          input.workspaceId,
          quote.credits,
          quote.providerCostMicros,
          occurredAt,
        );
      }
      const rows = await session.query<UsageRow>({
        text: `
          INSERT INTO rated_usage_events (
            workspace_id, idempotency_key, meter, provider, model, quantity,
            billable_units, credits_charged, provider_cost_micros, meter_price_id,
            resource_type, resource_id, metadata_json, occurred_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
          RETURNING ${USAGE_COLUMNS};
        `,
        values: [
          input.workspaceId,
          idempotencyKey,
          meter,
          provider,
          model,
          input.quantity,
          quote.billableUnits,
          quote.credits,
          quote.providerCostMicros,
          quote.meterPriceId,
          input.resourceType ?? '',
          input.resourceId ?? '',
          JSON.stringify(input.metadata ?? {}),
          occurredAt,
        ],
      });
      if (!rows[0]) throw new Error('rated usage event could not be loaded');
      await this.createThresholdAlerts(session, input.workspaceId, occurredAt);
      return { record: mapUsage(rows[0]), created: true };
    });
    if (result.created) this.onUsageRated?.();
    return result.record;
  }

  async setControls(input: SetCostControlsInput): Promise<CostControlRecord> {
    validateNullableNonNegativeInteger(input.monthlyCreditLimit, 'monthlyCreditLimit');
    validateNullableNonNegativeInteger(
      input.monthlyProviderCostMicrosLimit,
      'monthlyProviderCostMicrosLimit',
    );
    const thresholds = normalizeThresholds(input.alertThresholds ?? [50, 80, 100]);
    return this.database.transaction(async (session) => {
      await session.execute({
        text: `
          INSERT INTO workspace_cost_controls (
            workspace_id, monthly_credit_limit, monthly_provider_cost_micros_limit,
            hard_limit, overage_enabled, alert_thresholds_json, updated_by_user_id
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT(workspace_id) DO UPDATE SET
            monthly_credit_limit = excluded.monthly_credit_limit,
            monthly_provider_cost_micros_limit = excluded.monthly_provider_cost_micros_limit,
            hard_limit = excluded.hard_limit,
            overage_enabled = excluded.overage_enabled,
            alert_thresholds_json = excluded.alert_thresholds_json,
            updated_by_user_id = excluded.updated_by_user_id,
            updated_at = CURRENT_TIMESTAMP;
        `,
        values: [
          input.workspaceId,
          input.monthlyCreditLimit ?? null,
          input.monthlyProviderCostMicrosLimit ?? null,
          input.hardLimit !== false,
          input.overageEnabled === true,
          JSON.stringify(thresholds),
          input.updatedByUserId ?? null,
        ],
      });
      return this.controlsWith(session, input.workspaceId);
    });
  }

  controls(workspaceId: number): Promise<CostControlRecord> {
    return this.controlsWith(this.database, workspaceId);
  }

  async listAlerts(workspaceId: number): Promise<CostAlertRecord[]> {
    const rows = await this.database.query<{
      id: number;
      workspace_id: number;
      period_key: string;
      threshold_percent: number;
      metric: string;
      current_value: number;
      limit_value: number;
      status: string;
      created_at: string | Date;
      delivered_at: string | Date | null;
    }>({
      text: `
        SELECT id, workspace_id, period_key, threshold_percent, metric,
          current_value, limit_value, status, created_at, delivered_at
        FROM cost_alerts WHERE workspace_id = $1
        ORDER BY created_at DESC, id DESC;
      `,
      values: [workspaceId],
    });
    return rows.map((row) => ({
      id: Number(row.id),
      workspaceId: Number(row.workspace_id),
      periodKey: row.period_key,
      thresholdPercent: Number(row.threshold_percent),
      metric: row.metric,
      currentValue: Number(row.current_value),
      limitValue: Number(row.limit_value),
      status: row.status,
      createdAt: databaseTimestamp(row.created_at),
      deliveredAt: nullableDatabaseTimestamp(row.delivered_at),
    }));
  }

  summary(workspaceId: number, at = this.now()): Promise<UsagePeriodSummary> {
    return this.summaryWith(this.database, workspaceId, at);
  }

  async totalsForResource(
    workspaceId: number,
    resourceType: string,
    resourceId: string,
  ): Promise<ResourceUsageTotals> {
    const rows = await this.database.query<{
      event_count: number | string;
      quantity: number | string;
      credits: number | string;
      cost: number | string;
    }>({
      text: `
        SELECT COUNT(*) AS event_count, COALESCE(SUM(quantity), 0) AS quantity,
          COALESCE(SUM(credits_charged), 0) AS credits,
          COALESCE(SUM(provider_cost_micros), 0) AS cost
        FROM rated_usage_events
        WHERE workspace_id = $1 AND resource_type = $2 AND resource_id = $3;
      `,
      values: [workspaceId, resourceType, resourceId],
    });
    const row = rows[0];
    return {
      eventCount: Number(row?.event_count ?? 0),
      quantity: Number(row?.quantity ?? 0),
      credits: Number(row?.credits ?? 0),
      providerCostMicros: Number(row?.cost ?? 0),
    };
  }

  async assertProjected(
    workspaceId: number,
    quotes: UsageQuote[],
    occurredAt = this.now().toISOString(),
  ): Promise<void> {
    await this.database.transaction(async (session) => {
      await this.lockWorkspace(session, workspaceId);
      await this.assertWithinBudget(
        session,
        workspaceId,
        quotes.reduce((sum, quote) => sum + quote.credits, 0),
        quotes.reduce((sum, quote) => sum + quote.providerCostMicros, 0),
        normalizeTimestamp(occurredAt),
      );
    });
  }

  private async quoteWith(
    session: AsyncDatabaseSession,
    input: QuoteUsageInput,
  ): Promise<UsageQuote> {
    validateNonNegativeInteger(input.quantity, 'quantity');
    const meter = normalizeUsageKey(input.meter, 'meter');
    const occurredAt = normalizeTimestamp(input.occurredAt ?? this.now().toISOString());
    const price = await this.findPrice(
      session,
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

  private async findPrice(
    session: AsyncDatabaseSession,
    meter: string,
    provider: string,
    model: string,
    occurredAt: string,
  ): Promise<MeterPriceRecord | null> {
    const rows = await session.query<PriceRow>({
      text: `
        SELECT mp.id, mp.pricing_version_key, mp.meter, mp.provider, mp.model,
          mp.unit_size, mp.credits_per_unit, mp.provider_cost_micros_per_unit
        FROM meter_prices mp
        JOIN pricing_versions pv ON pv.key = mp.pricing_version_key
        WHERE mp.meter = $1 AND mp.active = TRUE AND pv.status = 'active'
          AND pv.effective_from <= $2
          AND (pv.effective_to IS NULL OR pv.effective_to > $2)
          AND mp.provider IN ('*', $3) AND mp.model IN ('*', $4)
        ORDER BY (mp.provider = $3) DESC, (mp.model = $4) DESC,
          pv.effective_from DESC, mp.id DESC LIMIT 1;
      `,
      values: [meter, occurredAt, provider, model],
    });
    return rows[0] ? mapPrice(rows[0]) : null;
  }

  private async findByKey(
    session: AsyncDatabaseSession,
    workspaceId: number,
    key: string,
  ): Promise<RatedUsageRecord | null> {
    const rows = await session.query<UsageRow>({
      text: `
        SELECT ${USAGE_COLUMNS} FROM rated_usage_events
        WHERE workspace_id = $1 AND idempotency_key = $2 LIMIT 1;
      `,
      values: [workspaceId, key],
    });
    return rows[0] ? mapUsage(rows[0]) : null;
  }

  private async controlsWith(
    session: AsyncDatabaseSession,
    workspaceId: number,
  ): Promise<CostControlRecord> {
    const rows = await session.query<ControlRow>({
      text: `
        SELECT workspace_id, monthly_credit_limit,
          monthly_provider_cost_micros_limit, hard_limit, overage_enabled,
          alert_thresholds_json
        FROM workspace_cost_controls WHERE workspace_id = $1 LIMIT 1;
      `,
      values: [workspaceId],
    });
    return rows[0] ? mapControl(rows[0]) : defaultControls(workspaceId);
  }

  private async summaryWith(
    session: AsyncDatabaseSession,
    workspaceId: number,
    at: Date,
  ): Promise<UsagePeriodSummary> {
    const period = monthPeriod(at);
    const rows = await session.query<SummaryRow>({
      text: `
        SELECT meter, SUM(quantity) AS quantity, SUM(credits_charged) AS credits,
          SUM(provider_cost_micros) AS cost, COUNT(*) AS count
        FROM rated_usage_events
        WHERE workspace_id = $1 AND occurred_at >= $2 AND occurred_at < $3
        GROUP BY meter ORDER BY meter;
      `,
      values: [workspaceId, period.start, period.end],
    });
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
      controls: await this.controlsWith(session, workspaceId),
    };
  }

  private async assertWithinBudget(
    session: AsyncDatabaseSession,
    workspaceId: number,
    projectedCredits: number,
    projectedCost: number,
    occurredAt: string,
  ): Promise<void> {
    const controls = await this.controlsWith(session, workspaceId);
    if (!controls.hardLimit || controls.overageEnabled) return;
    const summary = await this.summaryWith(session, workspaceId, new Date(occurredAt));
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

  private async createThresholdAlerts(
    session: AsyncDatabaseSession,
    workspaceId: number,
    occurredAt: string,
  ): Promise<void> {
    const summary = await this.summaryWith(session, workspaceId, new Date(occurredAt));
    const limits: Array<[string, number, number | null]> = [
      ['credits', summary.creditsCharged, summary.controls.monthlyCreditLimit],
      [
        'provider_cost_micros',
        summary.providerCostMicros,
        summary.controls.monthlyProviderCostMicrosLimit,
      ],
    ];
    for (const threshold of summary.controls.alertThresholds) {
      for (const [metric, current, limit] of limits) {
        if (limit === null || current * 100 < limit * threshold) continue;
        await session.execute({
          text: `
            INSERT INTO cost_alerts (
              workspace_id, period_key, threshold_percent, metric,
              current_value, limit_value
            ) VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT(workspace_id, period_key, threshold_percent, metric) DO NOTHING;
          `,
          values: [
            workspaceId,
            summary.periodStartsAt.slice(0, 7),
            threshold,
            metric,
            current,
            limit,
          ],
        });
      }
    }
  }

  private async lockWorkspace(
    session: AsyncDatabaseSession,
    workspaceId: number,
  ): Promise<void> {
    if (this.database.dialect !== 'postgres') return;
    await session.query({
      text: 'SELECT pg_advisory_xact_lock($1);',
      values: [workspaceId],
    });
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
    occurredAt: databaseTimestamp(row.occurred_at),
    createdAt: databaseTimestamp(row.created_at),
  };
}

function mapControl(row: ControlRow): CostControlRecord {
  return {
    workspaceId: Number(row.workspace_id),
    monthlyCreditLimit: nullableNumber(row.monthly_credit_limit),
    monthlyProviderCostMicrosLimit: nullableNumber(row.monthly_provider_cost_micros_limit),
    hardLimit: Boolean(row.hard_limit),
    overageEnabled: Boolean(row.overage_enabled),
    alertThresholds: normalizeThresholds(JSON.parse(row.alert_thresholds_json) as number[]),
  };
}

function defaultControls(workspaceId: number): CostControlRecord {
  return {
    workspaceId,
    monthlyCreditLimit: null,
    monthlyProviderCostMicrosLimit: null,
    hardLimit: true,
    overageEnabled: false,
    alertThresholds: [50, 80, 100],
  };
}

function nullableNumber(value: number | null): number | null {
  return value === null ? null : Number(value);
}

function validateReplay(
  existing: RatedUsageRecord,
  input: QuoteUsageInput,
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
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be non-negative`);
  }
}

function validateNullableNonNegativeInteger(
  value: number | null | undefined,
  label: string,
): void {
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
