import { type DatabaseAdapter } from '../db/adapter';
import { sqlValue } from '../db/sql';

export interface OperatorSubscriptionSummary {
  workspaceId: number;
  workspaceName: string;
  planKey: string;
  state: string;
  pendingPlanKey: string;
  provider: string;
  periodStartsAt: string;
  periodEndsAt: string | null;
  trialEndsAt: string | null;
  graceEndsAt: string | null;
  cancelAtPeriodEnd: boolean;
  updatedAt: string;
}

export interface OperatorUsageSummary {
  workspaceId: number;
  workspaceName: string;
  meter: string;
  quantity: number;
  billableUnits: number;
  creditsCharged: number;
  providerCostMicros: number;
  lastOccurredAt: string;
}

export interface OperatorInvoiceSummary {
  id: number;
  workspaceId: number;
  workspaceName: string;
  status: string;
  currency: string;
  amountDueMinor: number;
  amountPaidMinor: number;
  amountRefundedMinor: number;
  dueAt: string | null;
  paidAt: string | null;
  createdAt: string;
}

export interface OperatorRefundSummary {
  id: number;
  workspaceId: number;
  workspaceName: string;
  status: string;
  currency: string;
  amountMinor: number;
  createdAt: string;
}

export interface OperatorWebhookFailureSummary {
  id: number;
  provider: string;
  eventType: string;
  livemode: boolean;
  workspaceId: number | null;
  status: string;
  attempts: number;
  errorPresent: boolean;
  receivedAt: string;
  processedAt: string | null;
}

export interface OperatorPaymentSummary {
  invoices: OperatorInvoiceSummary[];
  refunds: OperatorRefundSummary[];
  webhookFailures: OperatorWebhookFailureSummary[];
}

interface SubscriptionRow {
  workspace_id: number;
  workspace_name: string;
  plan_key: string;
  state: string;
  pending_plan_key: string;
  provider: string;
  period_starts_at: string;
  period_ends_at: string | null;
  trial_ends_at: string | null;
  grace_ends_at: string | null;
  cancel_at_period_end: number;
  updated_at: string;
}

interface UsageRow {
  workspace_id: number;
  workspace_name: string;
  meter: string;
  quantity: number;
  billable_units: number;
  credits_charged: number;
  provider_cost_micros: number;
  last_occurred_at: string;
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
  due_at: string | null;
  paid_at: string | null;
  created_at: string;
}

interface RefundRow {
  id: number;
  workspace_id: number;
  workspace_name: string;
  status: string;
  currency: string;
  amount_minor: number;
  created_at: string;
}

interface WebhookFailureRow {
  id: number;
  provider: string;
  event_type: string;
  livemode: number;
  workspace_id: number | null;
  status: string;
  attempts: number;
  error_present: number;
  received_at: string;
  processed_at: string | null;
}

export class OperatorBillingReadRepository {
  constructor(
    private readonly db: DatabaseAdapter,
    private readonly now: () => Date = () => new Date(),
  ) {
  }

  listSubscriptions(workspaceId: number | undefined, limit = 100): OperatorSubscriptionSummary[] {
    const boundedLimit = bounded(limit);
    const filter = workspaceWhere('subscription.workspace_id', workspaceId);
    return this.db.query<SubscriptionRow>(`
      SELECT
        subscription.workspace_id,
        workspace.name AS workspace_name,
        subscription.plan_key,
        subscription.state,
        subscription.pending_plan_key,
        subscription.provider,
        subscription.period_starts_at,
        subscription.period_ends_at,
        subscription.trial_ends_at,
        subscription.grace_ends_at,
        subscription.cancel_at_period_end,
        subscription.updated_at
      FROM workspace_subscriptions subscription
      JOIN workspaces workspace ON workspace.id = subscription.workspace_id
      ${filter}
      ORDER BY subscription.updated_at DESC, subscription.workspace_id DESC
      LIMIT ${boundedLimit};
    `).map(toSubscriptionSummary);
  }

  listUsage(workspaceId: number | undefined, limit = 100): OperatorUsageSummary[] {
    const boundedLimit = bounded(limit);
    const workspaceFilter = workspaceId
      ? `AND usage.workspace_id = ${sqlValue(workspaceId)}`
      : '';
    return this.db.query<UsageRow>(`
      SELECT
        usage.workspace_id,
        workspace.name AS workspace_name,
        usage.meter,
        SUM(usage.quantity) AS quantity,
        SUM(usage.billable_units) AS billable_units,
        SUM(usage.credits_charged) AS credits_charged,
        SUM(usage.provider_cost_micros) AS provider_cost_micros,
        MAX(usage.occurred_at) AS last_occurred_at
      FROM rated_usage_events usage
      JOIN workspaces workspace ON workspace.id = usage.workspace_id
      WHERE usage.occurred_at >= ${sqlValue(monthStartIso(this.now()))}
      ${workspaceFilter}
      GROUP BY usage.workspace_id, workspace.name, usage.meter
      ORDER BY credits_charged DESC, usage.workspace_id DESC
      LIMIT ${boundedLimit};
    `).map(toUsageSummary);
  }

  listPayments(workspaceId: number | undefined, limit = 100): OperatorPaymentSummary {
    const boundedLimit = bounded(limit);
    const invoiceFilter = workspaceWhere('invoice.workspace_id', workspaceId);
    const refundFilter = workspaceWhere('refund.workspace_id', workspaceId);
    const webhookFilter = workspaceId
      ? `AND event.workspace_id = ${sqlValue(workspaceId)}`
      : '';
    const invoices = this.db.query<InvoiceRow>(`
      SELECT
        invoice.id,
        invoice.workspace_id,
        workspace.name AS workspace_name,
        invoice.status,
        invoice.currency,
        invoice.amount_due_minor,
        invoice.amount_paid_minor,
        invoice.amount_refunded_minor,
        invoice.due_at,
        invoice.paid_at,
        invoice.created_at
      FROM billing_invoices invoice
      JOIN workspaces workspace ON workspace.id = invoice.workspace_id
      ${invoiceFilter}
      ORDER BY invoice.created_at DESC, invoice.id DESC
      LIMIT ${boundedLimit};
    `).map(toInvoiceSummary);
    const refunds = this.db.query<RefundRow>(`
      SELECT
        refund.id,
        refund.workspace_id,
        workspace.name AS workspace_name,
        refund.status,
        refund.currency,
        refund.amount_minor,
        refund.created_at
      FROM billing_refunds refund
      JOIN workspaces workspace ON workspace.id = refund.workspace_id
      ${refundFilter}
      ORDER BY refund.created_at DESC, refund.id DESC
      LIMIT ${boundedLimit};
    `).map(toRefundSummary);
    const webhookFailures = this.db.query<WebhookFailureRow>(`
      SELECT
        event.id,
        event.provider,
        event.event_type,
        event.livemode,
        event.workspace_id,
        event.status,
        event.attempts,
        CASE WHEN event.error = '' THEN 0 ELSE 1 END AS error_present,
        event.received_at,
        event.processed_at
      FROM payment_webhook_events event
      WHERE event.status = 'failed'
      ${webhookFilter}
      ORDER BY event.received_at DESC, event.id DESC
      LIMIT ${boundedLimit};
    `).map(toWebhookFailureSummary);
    return { invoices, refunds, webhookFailures };
  }
}

function bounded(limit: number): number {
  return Math.min(Math.max(Math.floor(limit), 1), 200);
}

function workspaceWhere(column: string, workspaceId: number | undefined): string {
  return workspaceId ? `WHERE ${column} = ${sqlValue(workspaceId)}` : '';
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
    periodStartsAt: row.period_starts_at,
    periodEndsAt: row.period_ends_at,
    trialEndsAt: row.trial_ends_at,
    graceEndsAt: row.grace_ends_at,
    cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
    updatedAt: row.updated_at,
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
    lastOccurredAt: row.last_occurred_at,
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
    dueAt: row.due_at,
    paidAt: row.paid_at,
    createdAt: row.created_at,
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
    createdAt: row.created_at,
  };
}

function toWebhookFailureSummary(row: WebhookFailureRow): OperatorWebhookFailureSummary {
  return {
    id: Number(row.id),
    provider: row.provider,
    eventType: row.event_type,
    livemode: Boolean(row.livemode),
    workspaceId: row.workspace_id === null ? null : Number(row.workspace_id),
    status: row.status,
    attempts: Number(row.attempts),
    errorPresent: Boolean(row.error_present),
    receivedAt: row.received_at,
    processedAt: row.processed_at,
  };
}
