import { type AsyncDatabaseAdapter, type DatabaseParameter } from '../db/asyncAdapter';
import { databaseTimestamp, nullableDatabaseTimestamp } from '../db/databaseTimestamp';
import {
  type OperatorInvoiceSummary,
  type OperatorPaymentSummary,
  type OperatorRefundSummary,
  type OperatorSubscriptionSummary,
  type OperatorUsageSummary,
  type OperatorWebhookFailureSummary,
} from './operatorBillingReadRepository';
import { type OperatorBillingReadStore } from './operatorBillingReadStore';

interface SubscriptionRow {
  workspace_id: number;
  workspace_name: string;
  plan_key: string;
  state: string;
  pending_plan_key: string;
  provider: string;
  period_starts_at: string | Date;
  period_ends_at: string | Date | null;
  trial_ends_at: string | Date | null;
  grace_ends_at: string | Date | null;
  cancel_at_period_end: boolean | number;
  updated_at: string | Date;
}

interface UsageRow {
  workspace_id: number;
  workspace_name: string;
  meter: string;
  quantity: number | string;
  billable_units: number | string;
  credits_charged: number | string;
  provider_cost_micros: number | string;
  last_occurred_at: string | Date;
}

interface InvoiceRow {
  id: number;
  workspace_id: number;
  workspace_name: string;
  status: string;
  currency: string;
  amount_due_minor: number;
  amount_paid_minor: number;
  amount_refunded_minor: number;
  due_at: string | Date | null;
  paid_at: string | Date | null;
  created_at: string | Date;
}

interface RefundRow {
  id: number;
  workspace_id: number;
  workspace_name: string;
  status: string;
  currency: string;
  amount_minor: number;
  created_at: string | Date;
}

interface WebhookFailureRow {
  id: number;
  provider: string;
  event_type: string;
  livemode: boolean | number;
  workspace_id: number | null;
  status: string;
  attempts: number;
  error_present: boolean | number;
  received_at: string | Date;
  processed_at: string | Date | null;
}

export class AsyncOperatorBillingReadRepository implements OperatorBillingReadStore {
  constructor(
    private readonly database: AsyncDatabaseAdapter,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async listSubscriptions(
    workspaceId: number | undefined,
    limit = 100,
  ): Promise<OperatorSubscriptionSummary[]> {
    const query = scopedQuery(workspaceId, limit);
    const rows = await this.database.query<SubscriptionRow>({
      text: `
        SELECT subscription.workspace_id, workspace.name AS workspace_name,
          subscription.plan_key, subscription.state, subscription.pending_plan_key,
          subscription.provider, subscription.period_starts_at, subscription.period_ends_at,
          subscription.trial_ends_at, subscription.grace_ends_at,
          subscription.cancel_at_period_end, subscription.updated_at
        FROM workspace_subscriptions subscription
        JOIN workspaces workspace ON workspace.id = subscription.workspace_id
        ${workspaceId ? 'WHERE subscription.workspace_id = $1' : ''}
        ORDER BY subscription.updated_at DESC, subscription.workspace_id DESC
        LIMIT $${query.limitParameter};
      `,
      values: query.values,
    });
    return rows.map(toSubscriptionSummary);
  }

  async listUsage(
    workspaceId: number | undefined,
    limit = 100,
  ): Promise<OperatorUsageSummary[]> {
    const boundedLimit = bounded(limit);
    const values: DatabaseParameter[] = workspaceId
      ? [monthStartIso(this.now()), workspaceId, boundedLimit]
      : [monthStartIso(this.now()), boundedLimit];
    const rows = await this.database.query<UsageRow>({
      text: `
        SELECT usage.workspace_id, workspace.name AS workspace_name, usage.meter,
          SUM(usage.quantity) AS quantity, SUM(usage.billable_units) AS billable_units,
          SUM(usage.credits_charged) AS credits_charged,
          SUM(usage.provider_cost_micros) AS provider_cost_micros,
          MAX(usage.occurred_at) AS last_occurred_at
        FROM rated_usage_events usage
        JOIN workspaces workspace ON workspace.id = usage.workspace_id
        WHERE usage.occurred_at >= $1
        ${workspaceId ? 'AND usage.workspace_id = $2' : ''}
        GROUP BY usage.workspace_id, workspace.name, usage.meter
        ORDER BY credits_charged DESC, usage.workspace_id DESC
        LIMIT $${workspaceId ? 3 : 2};
      `,
      values,
    });
    return rows.map(toUsageSummary);
  }

  async listPayments(
    workspaceId: number | undefined,
    limit = 100,
  ): Promise<OperatorPaymentSummary> {
    const query = scopedQuery(workspaceId, limit);
    const [invoiceRows, refundRows, webhookRows] = await Promise.all([
      this.database.query<InvoiceRow>({
        text: `
          SELECT invoice.id, invoice.workspace_id, workspace.name AS workspace_name,
            invoice.status, invoice.currency, invoice.amount_due_minor,
            invoice.amount_paid_minor, invoice.amount_refunded_minor,
            invoice.due_at, invoice.paid_at, invoice.created_at
          FROM billing_invoices invoice
          JOIN workspaces workspace ON workspace.id = invoice.workspace_id
          ${workspaceId ? 'WHERE invoice.workspace_id = $1' : ''}
          ORDER BY invoice.created_at DESC, invoice.id DESC
          LIMIT $${query.limitParameter};
        `,
        values: query.values,
      }),
      this.database.query<RefundRow>({
        text: `
          SELECT refund.id, refund.workspace_id, workspace.name AS workspace_name,
            refund.status, refund.currency, refund.amount_minor, refund.created_at
          FROM billing_refunds refund
          JOIN workspaces workspace ON workspace.id = refund.workspace_id
          ${workspaceId ? 'WHERE refund.workspace_id = $1' : ''}
          ORDER BY refund.created_at DESC, refund.id DESC
          LIMIT $${query.limitParameter};
        `,
        values: query.values,
      }),
      this.database.query<WebhookFailureRow>({
        text: `
          SELECT event.id, event.provider, event.event_type, event.livemode,
            event.workspace_id, event.status, event.attempts,
            CASE WHEN event.error = '' THEN 0 ELSE 1 END AS error_present,
            event.received_at, event.processed_at
          FROM payment_webhook_events event WHERE event.status = 'failed'
          ${workspaceId ? 'AND event.workspace_id = $1' : ''}
          ORDER BY event.received_at DESC, event.id DESC
          LIMIT $${query.limitParameter};
        `,
        values: query.values,
      }),
    ]);
    return {
      invoices: invoiceRows.map(toInvoiceSummary),
      refunds: refundRows.map(toRefundSummary),
      webhookFailures: webhookRows.map(toWebhookFailureSummary),
    };
  }
}

function bounded(limit: number): number {
  return Math.min(Math.max(Math.floor(limit), 1), 200);
}

function scopedQuery(
  workspaceId: number | undefined,
  limit: number,
): { limitParameter: number; values: DatabaseParameter[] } {
  const boundedLimit = bounded(limit);
  return workspaceId
    ? { limitParameter: 2, values: [workspaceId, boundedLimit] }
    : { limitParameter: 1, values: [boundedLimit] };
}

function monthStartIso(value: Date): string {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1)).toISOString();
}

function toSubscriptionSummary(row: SubscriptionRow): OperatorSubscriptionSummary {
  return {
    workspaceId: Number(row.workspace_id),
    workspaceName: row.workspace_name,
    planKey: row.plan_key,
    state: row.state,
    pendingPlanKey: row.pending_plan_key,
    provider: row.provider,
    periodStartsAt: databaseTimestamp(row.period_starts_at),
    periodEndsAt: nullableDatabaseTimestamp(row.period_ends_at),
    trialEndsAt: nullableDatabaseTimestamp(row.trial_ends_at),
    graceEndsAt: nullableDatabaseTimestamp(row.grace_ends_at),
    cancelAtPeriodEnd: row.cancel_at_period_end === true || Number(row.cancel_at_period_end) === 1,
    updatedAt: databaseTimestamp(row.updated_at),
  };
}

function toUsageSummary(row: UsageRow): OperatorUsageSummary {
  return {
    workspaceId: Number(row.workspace_id),
    workspaceName: row.workspace_name,
    meter: row.meter,
    quantity: Number(row.quantity),
    billableUnits: Number(row.billable_units),
    creditsCharged: Number(row.credits_charged),
    providerCostMicros: Number(row.provider_cost_micros),
    lastOccurredAt: databaseTimestamp(row.last_occurred_at),
  };
}

function toInvoiceSummary(row: InvoiceRow): OperatorInvoiceSummary {
  return {
    id: Number(row.id),
    workspaceId: Number(row.workspace_id),
    workspaceName: row.workspace_name,
    status: row.status,
    currency: row.currency,
    amountDueMinor: Number(row.amount_due_minor),
    amountPaidMinor: Number(row.amount_paid_minor),
    amountRefundedMinor: Number(row.amount_refunded_minor),
    dueAt: nullableDatabaseTimestamp(row.due_at),
    paidAt: nullableDatabaseTimestamp(row.paid_at),
    createdAt: databaseTimestamp(row.created_at),
  };
}

function toRefundSummary(row: RefundRow): OperatorRefundSummary {
  return {
    id: Number(row.id),
    workspaceId: Number(row.workspace_id),
    workspaceName: row.workspace_name,
    status: row.status,
    currency: row.currency,
    amountMinor: Number(row.amount_minor),
    createdAt: databaseTimestamp(row.created_at),
  };
}

function toWebhookFailureSummary(row: WebhookFailureRow): OperatorWebhookFailureSummary {
  return {
    id: Number(row.id),
    provider: row.provider,
    eventType: row.event_type,
    livemode: row.livemode === true || Number(row.livemode) === 1,
    workspaceId: row.workspace_id === null ? null : Number(row.workspace_id),
    status: row.status,
    attempts: Number(row.attempts),
    errorPresent: row.error_present === true || Number(row.error_present) === 1,
    receivedAt: databaseTimestamp(row.received_at),
    processedAt: nullableDatabaseTimestamp(row.processed_at),
  };
}
