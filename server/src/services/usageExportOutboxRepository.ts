import { type DatabaseAdapter } from '../db/adapter';
import { sqlValue } from '../db/sql';
import { type UsageMeterExportPayload } from './usageMeterExporter';

interface ClaimedExportRow {
  id: number;
  rated_usage_event_id: number;
  attempts: number;
}

interface UsageEventRow {
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
  resource_type: string;
  resource_id: string;
  metadata_json: string;
  occurred_at: string;
  created_at: string;
}

export interface ClaimedUsageExport {
  id: number;
  attempts: number;
  payload: UsageMeterExportPayload;
}

export class UsageExportOutboxRepository {
  constructor(
    private readonly db: DatabaseAdapter,
    private readonly now: () => Date = () => new Date(),
  ) {
  }

  claimNext(destination: string): ClaimedUsageExport | null {
    const now = this.now().toISOString();
    this.db.run(`
      UPDATE usage_meter_exports
      SET status = 'failed', last_error = 'delivery lease expired',
        next_attempt_at = ${sqlValue(now)}, updated_at = ${sqlValue(now)}
      WHERE destination = ${sqlValue(destination)}
        AND status = 'delivering'
        AND datetime(updated_at) <= datetime(${sqlValue(now)}, '-5 minutes');
    `);
    const claimed = this.db.query<ClaimedExportRow>(`
      UPDATE usage_meter_exports
      SET status = 'delivering', attempts = attempts + 1,
        updated_at = ${sqlValue(now)}
      WHERE id = (
        SELECT id FROM usage_meter_exports
        WHERE destination = ${sqlValue(destination)}
          AND status IN ('pending', 'failed')
          AND datetime(next_attempt_at) <= datetime(${sqlValue(now)})
        ORDER BY id
        LIMIT 1
      )
      RETURNING id, rated_usage_event_id, attempts;
    `)[0];
    if (!claimed) return null;

    const event = this.db.query<UsageEventRow>(`
      SELECT id, workspace_id, idempotency_key, meter, provider, model,
        quantity, billable_units, credits_charged, provider_cost_micros,
        resource_type, resource_id, metadata_json, occurred_at, created_at
      FROM rated_usage_events
      WHERE id = ${sqlValue(claimed.rated_usage_event_id)}
      LIMIT 1;
    `)[0];
    if (!event) {
      this.markFailed(claimed.id, claimed.attempts, 'rated usage event is missing');
      return null;
    }
    return {
      id: Number(claimed.id),
      attempts: Number(claimed.attempts),
      payload: mapPayload(event),
    };
  }

  markDelivered(id: number): void {
    const now = this.now().toISOString();
    this.db.run(`
      UPDATE usage_meter_exports
      SET status = 'delivered', last_error = '', delivered_at = ${sqlValue(now)},
        updated_at = ${sqlValue(now)}
      WHERE id = ${sqlValue(id)} AND status = 'delivering';
    `);
  }

  markFailed(id: number, attempts: number, error: string): void {
    const nextAttemptAt = new Date(
      this.now().getTime() + retryDelayMs(attempts),
    ).toISOString();
    this.db.run(`
      UPDATE usage_meter_exports
      SET status = 'failed', last_error = ${sqlValue(error.slice(0, 1000))},
        next_attempt_at = ${sqlValue(nextAttemptAt)}, updated_at = ${sqlValue(this.now().toISOString())}
      WHERE id = ${sqlValue(id)} AND status = 'delivering';
    `);
  }

  nextAttemptDelayMs(destination: string): number | null {
    const now = this.now().toISOString();
    const row = this.db.query<{ delay_ms: number | null }>(`
      SELECT MAX(0, CAST(
        (julianday(MIN(next_attempt_at)) - julianday(${sqlValue(now)})) * 86400000
        AS INTEGER
      )) AS delay_ms
      FROM usage_meter_exports
      WHERE destination = ${sqlValue(destination)}
        AND status IN ('pending', 'failed');
    `)[0];
    return row?.delay_ms === null || row?.delay_ms === undefined
      ? null
      : Number(row.delay_ms);
  }
}

function mapPayload(row: UsageEventRow): UsageMeterExportPayload {
  return {
    eventId: Number(row.id),
    workspaceId: Number(row.workspace_id),
    idempotencyKey: row.idempotency_key,
    meter: row.meter,
    provider: row.provider,
    model: row.model,
    quantity: Number(row.quantity),
    billableUnits: Number(row.billable_units),
    creditsCharged: Number(row.credits_charged),
    providerCostMicros: Number(row.provider_cost_micros),
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  };
}

function retryDelayMs(attempts: number): number {
  const exponent = Math.min(Math.max(attempts - 1, 0), 12);
  return Math.min(60 * 60 * 1000, 1000 * (2 ** exponent));
}
