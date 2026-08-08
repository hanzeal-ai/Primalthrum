import {
  type AsyncDatabaseAdapter,
  type AsyncDatabaseSession,
} from '../db/asyncAdapter';
import { databaseTimestamp } from '../db/databaseTimestamp';
import { type ClaimedUsageExport } from './usageExportOutboxRepository';
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
  occurred_at: string | Date;
  created_at: string | Date;
}

const USAGE_EVENT_COLUMNS = [
  'id', 'workspace_id', 'idempotency_key', 'meter', 'provider', 'model',
  'quantity', 'billable_units', 'credits_charged', 'provider_cost_micros',
  'resource_type', 'resource_id', 'metadata_json', 'occurred_at', 'created_at',
].join(', ');

export class AsyncUsageExportOutboxRepository {
  constructor(
    private readonly database: AsyncDatabaseAdapter,
    private readonly now: () => Date = () => new Date(),
  ) {}

  claimNext(destinationValue: string): Promise<ClaimedUsageExport | null> {
    const destination = normalizeDestination(destinationValue);
    const now = this.now();
    const nowTimestamp = now.toISOString();
    const leaseExpiredAt = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
    return this.database.transaction(async (session) => {
      await session.execute({
        text: `
          UPDATE usage_meter_exports
          SET status = 'failed', last_error = 'delivery lease expired',
            next_attempt_at = $2, updated_at = $2
          WHERE destination = $1 AND status = 'delivering' AND updated_at <= $3;
        `,
        values: [destination, nowTimestamp, leaseExpiredAt],
      });
      const claimed = await this.claimRow(session, destination, nowTimestamp);
      if (!claimed) return null;
      const events = await session.query<UsageEventRow>({
        text: `
          SELECT ${USAGE_EVENT_COLUMNS} FROM rated_usage_events
          WHERE id = $1 LIMIT 1;
        `,
        values: [claimed.rated_usage_event_id],
      });
      if (!events[0]) {
        await this.markFailedWith(
          session,
          claimed.id,
          claimed.attempts,
          'rated usage event is missing',
        );
        return null;
      }
      return {
        id: Number(claimed.id),
        attempts: Number(claimed.attempts),
        payload: mapPayload(events[0]),
      };
    });
  }

  async markDelivered(id: number): Promise<void> {
    const now = this.now().toISOString();
    await this.database.execute({
      text: `
        UPDATE usage_meter_exports
        SET status = 'delivered', last_error = '', delivered_at = $2, updated_at = $2
        WHERE id = $1 AND status = 'delivering';
      `,
      values: [id, now],
    });
  }

  async markFailed(id: number, attempts: number, error: string): Promise<void> {
    await this.markFailedWith(this.database, id, attempts, error);
  }

  async nextAttemptDelayMs(destinationValue: string): Promise<number | null> {
    const destination = normalizeDestination(destinationValue);
    const rows = await this.database.query<{ next_attempt_at: string | Date | null }>({
      text: `
        SELECT MIN(next_attempt_at) AS next_attempt_at
        FROM usage_meter_exports
        WHERE destination = $1 AND status IN ('pending', 'failed');
      `,
      values: [destination],
    });
    const value = rows[0]?.next_attempt_at;
    if (value === null || value === undefined) return null;
    return Math.max(0, new Date(databaseTimestamp(value)).getTime() - this.now().getTime());
  }

  private async claimRow(
    session: AsyncDatabaseSession,
    destination: string,
    now: string,
  ): Promise<ClaimedExportRow | null> {
    const text = this.database.dialect === 'postgres'
      ? `
          WITH next_export AS (
            SELECT id FROM usage_meter_exports
            WHERE destination = $1 AND status IN ('pending', 'failed')
              AND next_attempt_at <= $2
            ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1
          )
          UPDATE usage_meter_exports AS export
          SET status = 'delivering', attempts = export.attempts + 1, updated_at = $2
          FROM next_export
          WHERE export.id = next_export.id
          RETURNING export.id, export.rated_usage_event_id, export.attempts;
        `
      : `
          UPDATE usage_meter_exports
          SET status = 'delivering', attempts = attempts + 1, updated_at = $2
          WHERE id = (
            SELECT id FROM usage_meter_exports
            WHERE destination = $1 AND status IN ('pending', 'failed')
              AND next_attempt_at <= $2
            ORDER BY id LIMIT 1
          )
          RETURNING id, rated_usage_event_id, attempts;
        `;
    const rows = await session.query<ClaimedExportRow>({
      text,
      values: [destination, now],
    });
    return rows[0] ?? null;
  }

  private async markFailedWith(
    session: AsyncDatabaseSession,
    id: number,
    attempts: number,
    error: string,
  ): Promise<void> {
    const now = this.now();
    const nextAttemptAt = new Date(now.getTime() + retryDelayMs(attempts)).toISOString();
    await session.execute({
      text: `
        UPDATE usage_meter_exports
        SET status = 'failed', last_error = $2, next_attempt_at = $3, updated_at = $4
        WHERE id = $1 AND status = 'delivering';
      `,
      values: [id, error.slice(0, 1000), nextAttemptAt, now.toISOString()],
    });
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
    occurredAt: databaseTimestamp(row.occurred_at),
    createdAt: databaseTimestamp(row.created_at),
  };
}

function normalizeDestination(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)) {
    throw new Error('usage export destination has an invalid format');
  }
  return normalized;
}

function retryDelayMs(attempts: number): number {
  const exponent = Math.min(Math.max(attempts - 1, 0), 12);
  return Math.min(60 * 60 * 1000, 1000 * (2 ** exponent));
}
