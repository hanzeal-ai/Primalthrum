import { initializeSchema } from '../db/schema';
import { SqliteDatabase, sqlValue } from '../db/sqlite';
import { ensureBillingWorkspaceBaseline } from './billingWorkspaceBaseline';
import type {
  BillingInvoiceRecord,
  CommercialSubscriptionState,
  PaymentCheckoutRecord,
  PaymentCustomerRecord,
  PaymentPriceRecord,
  PaymentWebhookEvent,
  WorkspaceSubscriptionRecord,
} from './paymentTypes';

interface PriceRow {
  provider: string;
  plan_key: string;
  provider_price_ref: string;
  active: number;
}

interface CustomerRow {
  workspace_id: number;
  provider: string;
  provider_customer_ref: string;
  email: string;
}

interface CheckoutRow {
  id: number;
  workspace_id: number;
  provider: string;
  idempotency_key: string;
  provider_session_ref: string;
  plan_key: string;
  status: string;
  checkout_url: string;
  expires_at: string | null;
  completed_at: string | null;
}

interface SubscriptionRow {
  workspace_id: number;
  plan_key: string;
  state: CommercialSubscriptionState;
  period_starts_at: string;
  period_ends_at: string | null;
  trial_ends_at: string | null;
  cancel_at_period_end: number;
  provider: string;
  provider_customer_ref: string;
  provider_subscription_ref: string;
  provider_price_ref: string;
  provider_subscription_item_ref: string;
  pending_plan_key: string;
  grace_ends_at: string | null;
  canceled_at: string | null;
  latest_provider_event_created: number;
  latest_provider_event_ref: string;
}

interface InvoiceRow {
  id: number;
  workspace_id: number;
  provider: string;
  provider_invoice_ref: string;
  status: string;
  currency: string;
  amount_due_minor: number;
  amount_paid_minor: number;
  amount_refunded_minor: number;
  period_starts_at: string | null;
  period_ends_at: string | null;
  hosted_invoice_url: string;
  invoice_pdf_url: string;
  due_at: string | null;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
}

export class PaymentLifecycleRepository {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {
    initializeSchema(db);
  }

  configurePrice(provider: string, planKey: string, priceRef: string): PaymentPriceRecord {
    this.db.run(`
      INSERT INTO payment_prices (provider, plan_key, provider_price_ref)
      VALUES (${sqlValue(provider)}, ${sqlValue(planKey)}, ${sqlValue(priceRef)})
      ON CONFLICT(provider, plan_key) DO UPDATE SET
        provider_price_ref = excluded.provider_price_ref,
        active = 1,
        updated_at = CURRENT_TIMESTAMP;
    `);
    const price = this.priceForPlan(provider, planKey);
    if (!price) throw new Error('payment price could not be loaded');
    return price;
  }

  priceForPlan(provider: string, planKey: string): PaymentPriceRecord | null {
    const row = this.db.query<PriceRow>(`
      SELECT provider, plan_key, provider_price_ref, active
      FROM payment_prices
      WHERE provider = ${sqlValue(provider)} AND plan_key = ${sqlValue(planKey)}
        AND active = 1
      LIMIT 1;
    `)[0];
    return row ? mapPrice(row) : null;
  }

  planForPrice(provider: string, priceRef: string): string | null {
    return this.db.query<{ plan_key: string }>(`
      SELECT plan_key FROM payment_prices
      WHERE provider = ${sqlValue(provider)}
        AND provider_price_ref = ${sqlValue(priceRef)} AND active = 1
      LIMIT 1;
    `)[0]?.plan_key ?? null;
  }

  customer(workspaceId: number, provider: string): PaymentCustomerRecord | null {
    const row = this.db.query<CustomerRow>(`
      SELECT workspace_id, provider, provider_customer_ref, email
      FROM payment_customers
      WHERE workspace_id = ${sqlValue(workspaceId)} AND provider = ${sqlValue(provider)}
      LIMIT 1;
    `)[0];
    return row ? mapCustomer(row) : null;
  }

  upsertCustomer(input: PaymentCustomerRecord): PaymentCustomerRecord {
    this.db.run(`
      INSERT INTO payment_customers (
        workspace_id, provider, provider_customer_ref, email
      ) VALUES (
        ${sqlValue(input.workspaceId)}, ${sqlValue(input.provider)},
        ${sqlValue(input.providerCustomerRef)}, ${sqlValue(input.email)}
      ) ON CONFLICT(workspace_id, provider) DO UPDATE SET
        provider_customer_ref = excluded.provider_customer_ref,
        email = CASE WHEN excluded.email = '' THEN payment_customers.email ELSE excluded.email END,
        updated_at = CURRENT_TIMESTAMP;
    `);
    const customer = this.customer(input.workspaceId, input.provider);
    if (!customer) throw new Error('payment customer could not be loaded');
    return customer;
  }

  workspaceForProviderObject(
    provider: string,
    customerRef: string,
    subscriptionRef = '',
  ): number | null {
    const row = this.db.query<{ workspace_id: number }>(`
      SELECT workspace_id FROM payment_customers
      WHERE provider = ${sqlValue(provider)}
        AND provider_customer_ref = ${sqlValue(customerRef)}
      UNION
      SELECT workspace_id FROM workspace_subscriptions
      WHERE provider = ${sqlValue(provider)}
        AND provider_subscription_ref = ${sqlValue(subscriptionRef)}
      LIMIT 1;
    `)[0];
    return row ? Number(row.workspace_id) : null;
  }

  recordCheckout(input: {
    workspaceId: number;
    provider: string;
    idempotencyKey: string;
    providerSessionRef: string;
    planKey: string;
    checkoutUrl: string;
    createdByUserId: number;
    expiresAt?: string | null;
  }): PaymentCheckoutRecord {
    this.db.run(`
      INSERT INTO payment_checkout_sessions (
        workspace_id, provider, idempotency_key, provider_session_ref,
        plan_key, checkout_url, created_by_user_id, expires_at
      ) VALUES (
        ${sqlValue(input.workspaceId)}, ${sqlValue(input.provider)},
        ${sqlValue(input.idempotencyKey)}, ${sqlValue(input.providerSessionRef)},
        ${sqlValue(input.planKey)}, ${sqlValue(input.checkoutUrl)},
        ${sqlValue(input.createdByUserId)}, ${sqlValue(input.expiresAt ?? null)}
      ) ON CONFLICT(workspace_id, provider, idempotency_key) DO NOTHING;
    `);
    const checkout = this.checkoutByKey(input.workspaceId, input.provider, input.idempotencyKey);
    if (!checkout) throw new Error('checkout session could not be loaded');
    return checkout;
  }

  checkoutByKey(workspaceId: number, provider: string, key: string): PaymentCheckoutRecord | null {
    const row = this.db.query<CheckoutRow>(`
      SELECT id, workspace_id, provider, idempotency_key, provider_session_ref,
        plan_key, status, checkout_url, expires_at, completed_at
      FROM payment_checkout_sessions
      WHERE workspace_id = ${sqlValue(workspaceId)} AND provider = ${sqlValue(provider)}
        AND idempotency_key = ${sqlValue(key)}
      LIMIT 1;
    `)[0];
    return row ? mapCheckout(row) : null;
  }

  completeCheckout(provider: string, sessionRef: string): void {
    this.db.run(`
      UPDATE payment_checkout_sessions
      SET status = 'complete', completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
        updated_at = CURRENT_TIMESTAMP
      WHERE provider = ${sqlValue(provider)}
        AND provider_session_ref = ${sqlValue(sessionRef)};
    `);
  }

  markPendingPlan(workspaceId: number, planKey: string): void {
    ensureBillingWorkspaceBaseline(this.db, workspaceId);
    this.db.run(`
      UPDATE workspace_subscriptions
      SET pending_plan_key = ${sqlValue(planKey)}, updated_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ${sqlValue(workspaceId)};
    `);
  }

  receiveWebhook(
    provider: string,
    event: PaymentWebhookEvent,
    rawPayload: string,
    signatureTimestamp: number | null,
  ): boolean {
    const existing = this.db.query<{ id: number }>(`
      SELECT id FROM payment_webhook_events
      WHERE provider = ${sqlValue(provider)} AND provider_event_ref = ${sqlValue(event.id)}
      LIMIT 1;
    `)[0];
    if (existing) return false;
    this.db.run(`
      INSERT INTO payment_webhook_events (
        provider, provider_event_ref, event_type, livemode, api_version,
        payload_json, signature_timestamp, object_created_at
      ) VALUES (
        ${sqlValue(provider)}, ${sqlValue(event.id)}, ${sqlValue(event.type)},
        ${event.livemode ? 1 : 0}, ${sqlValue(event.api_version ?? '')},
        ${sqlValue(rawPayload)}, ${sqlValue(signatureTimestamp)}, ${sqlValue(event.created)}
      );
    `);
    return true;
  }

  finishWebhook(
    provider: string,
    eventRef: string,
    status: 'processed' | 'ignored' | 'failed',
    workspaceId: number | null,
    error = '',
  ): void {
    this.db.run(`
      UPDATE payment_webhook_events
      SET status = ${sqlValue(status)}, workspace_id = ${sqlValue(workspaceId)},
        error = ${sqlValue(error)}, processed_at = CURRENT_TIMESTAMP
      WHERE provider = ${sqlValue(provider)}
        AND provider_event_ref = ${sqlValue(eventRef)};
    `);
  }

  subscription(workspaceId: number): WorkspaceSubscriptionRecord {
    ensureBillingWorkspaceBaseline(this.db, workspaceId);
    const row = this.subscriptionRow(workspaceId);
    if (!row) throw new Error('workspace subscription could not be loaded');
    return mapSubscription(row);
  }

  applySubscriptionState(input: {
    workspaceId: number;
    provider: string;
    eventRef: string;
    eventCreated: number;
    state: CommercialSubscriptionState;
    planKey: string;
    customerRef?: string;
    subscriptionRef?: string;
    priceRef?: string;
    subscriptionItemRef?: string;
    periodStartsAt?: string | null;
    periodEndsAt?: string | null;
    trialEndsAt?: string | null;
    cancelAtPeriodEnd?: boolean;
    graceEndsAt?: string | null;
  }): boolean {
    ensureBillingWorkspaceBaseline(this.db, input.workspaceId);
    const current = this.subscriptionRow(input.workspaceId);
    if (!current) throw new Error('workspace subscription could not be loaded');
    if (
      input.eventCreated < Number(current.latest_provider_event_created)
      || (
        input.eventCreated === Number(current.latest_provider_event_created)
        && input.eventRef <= current.latest_provider_event_ref
      )
    ) {
      return false;
    }
    const effectiveAt = new Date(input.eventCreated * 1000).toISOString();
    const canceledAt = ['canceled', 'refunded'].includes(input.state) ? effectiveAt : null;
    this.db.run(`
      BEGIN IMMEDIATE;
      UPDATE workspace_subscriptions
      SET plan_key = ${sqlValue(input.planKey)}, state = ${sqlValue(input.state)},
        period_starts_at = ${sqlValue(input.periodStartsAt ?? current.period_starts_at)},
        period_ends_at = ${sqlValue(input.periodEndsAt ?? current.period_ends_at)},
        trial_ends_at = ${sqlValue(input.trialEndsAt ?? current.trial_ends_at)},
        cancel_at_period_end = ${input.cancelAtPeriodEnd ? 1 : 0},
        provider = ${sqlValue(input.provider)},
        provider_customer_ref = ${sqlValue(input.customerRef ?? current.provider_customer_ref)},
        provider_subscription_ref = ${sqlValue(input.subscriptionRef ?? current.provider_subscription_ref)},
        provider_price_ref = ${sqlValue(input.priceRef ?? current.provider_price_ref)},
        provider_subscription_item_ref = ${sqlValue(input.subscriptionItemRef ?? current.provider_subscription_item_ref)},
        pending_plan_key = '',
        grace_ends_at = ${sqlValue(input.graceEndsAt ?? null)},
        canceled_at = ${sqlValue(canceledAt)},
        latest_provider_event_created = ${sqlValue(input.eventCreated)},
        latest_provider_event_ref = ${sqlValue(input.eventRef)},
        updated_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ${sqlValue(input.workspaceId)};
      INSERT INTO subscription_state_events (
        workspace_id, provider, provider_event_ref, from_state, to_state,
        plan_key, effective_at
      ) VALUES (
        ${sqlValue(input.workspaceId)}, ${sqlValue(input.provider)}, ${sqlValue(input.eventRef)},
        ${sqlValue(current.state)}, ${sqlValue(input.state)}, ${sqlValue(input.planKey)},
        ${sqlValue(effectiveAt)}
      );
      COMMIT;
    `);
    return true;
  }

  upsertInvoice(input: {
    workspaceId: number;
    provider: string;
    invoiceRef: string;
    customerRef?: string;
    subscriptionRef?: string;
    status: string;
    currency?: string;
    amountDueMinor?: number;
    amountPaidMinor?: number;
    amountRefundedMinor?: number;
    periodStartsAt?: string | null;
    periodEndsAt?: string | null;
    hostedInvoiceUrl?: string;
    invoicePdfUrl?: string;
    dueAt?: string | null;
    paidAt?: string | null;
  }): void {
    this.db.run(`
      INSERT INTO billing_invoices (
        workspace_id, provider, provider_invoice_ref, provider_customer_ref,
        provider_subscription_ref, status, currency, amount_due_minor,
        amount_paid_minor, amount_refunded_minor, period_starts_at,
        period_ends_at, hosted_invoice_url, invoice_pdf_url, due_at, paid_at
      ) VALUES (
        ${sqlValue(input.workspaceId)}, ${sqlValue(input.provider)}, ${sqlValue(input.invoiceRef)},
        ${sqlValue(input.customerRef ?? '')}, ${sqlValue(input.subscriptionRef ?? '')},
        ${sqlValue(input.status)}, ${sqlValue(input.currency ?? 'usd')},
        ${sqlValue(input.amountDueMinor ?? 0)}, ${sqlValue(input.amountPaidMinor ?? 0)},
        ${sqlValue(input.amountRefundedMinor ?? 0)}, ${sqlValue(input.periodStartsAt ?? null)},
        ${sqlValue(input.periodEndsAt ?? null)}, ${sqlValue(input.hostedInvoiceUrl ?? '')},
        ${sqlValue(input.invoicePdfUrl ?? '')}, ${sqlValue(input.dueAt ?? null)},
        ${sqlValue(input.paidAt ?? null)}
      ) ON CONFLICT(provider, provider_invoice_ref) DO UPDATE SET
        status = excluded.status,
        amount_due_minor = excluded.amount_due_minor,
        amount_paid_minor = excluded.amount_paid_minor,
        amount_refunded_minor = excluded.amount_refunded_minor,
        hosted_invoice_url = excluded.hosted_invoice_url,
        invoice_pdf_url = excluded.invoice_pdf_url,
        due_at = excluded.due_at,
        paid_at = excluded.paid_at,
        updated_at = CURRENT_TIMESTAMP;
    `);
  }

  upsertRefund(input: {
    workspaceId: number;
    provider: string;
    refundRef: string;
    paymentRef?: string;
    invoiceRef?: string;
    status: string;
    amountMinor?: number;
    currency?: string;
    reason?: string;
    providerCreatedAt?: string | null;
  }): void {
    this.db.run(`
      INSERT INTO billing_refunds (
        workspace_id, provider, provider_refund_ref, provider_payment_ref,
        provider_invoice_ref, status, amount_minor, currency, reason, provider_created_at
      ) VALUES (
        ${sqlValue(input.workspaceId)}, ${sqlValue(input.provider)}, ${sqlValue(input.refundRef)},
        ${sqlValue(input.paymentRef ?? '')}, ${sqlValue(input.invoiceRef ?? '')},
        ${sqlValue(input.status)}, ${sqlValue(input.amountMinor ?? 0)},
        ${sqlValue(input.currency ?? 'usd')}, ${sqlValue(input.reason ?? '')},
        ${sqlValue(input.providerCreatedAt ?? null)}
      ) ON CONFLICT(provider, provider_refund_ref) DO UPDATE SET
        status = excluded.status, amount_minor = excluded.amount_minor,
        reason = excluded.reason, updated_at = CURRENT_TIMESTAMP;
    `);
  }

  recordInvoiceRefund(input: {
    workspaceId: number;
    provider: string;
    invoiceRef: string;
    amountRefundedMinor: number;
    status: string;
  }): void {
    this.db.run(`
      INSERT INTO billing_invoices (
        workspace_id, provider, provider_invoice_ref, status, amount_refunded_minor
      ) VALUES (
        ${sqlValue(input.workspaceId)}, ${sqlValue(input.provider)},
        ${sqlValue(input.invoiceRef)}, ${sqlValue(input.status)},
        ${sqlValue(input.amountRefundedMinor)}
      ) ON CONFLICT(provider, provider_invoice_ref) DO UPDATE SET
        status = excluded.status,
        amount_refunded_minor = excluded.amount_refunded_minor,
        updated_at = CURRENT_TIMESTAMP;
    `);
  }

  listInvoices(workspaceId: number): BillingInvoiceRecord[] {
    return this.db.query<InvoiceRow>(`
      SELECT id, workspace_id, provider, provider_invoice_ref, status, currency,
        amount_due_minor, amount_paid_minor, amount_refunded_minor,
        period_starts_at, period_ends_at, hosted_invoice_url, invoice_pdf_url,
        due_at, paid_at, created_at, updated_at
      FROM billing_invoices
      WHERE workspace_id = ${sqlValue(workspaceId)}
      ORDER BY created_at DESC, id DESC;
    `).map(mapInvoice);
  }

  nowIso(): string {
    return this.now().toISOString();
  }

  private subscriptionRow(workspaceId: number): SubscriptionRow | null {
    return this.db.query<SubscriptionRow>(`
      SELECT workspace_id, plan_key, state, period_starts_at, period_ends_at,
        trial_ends_at, cancel_at_period_end, provider, provider_customer_ref,
        provider_subscription_ref, provider_price_ref, provider_subscription_item_ref,
        pending_plan_key, grace_ends_at, canceled_at,
        latest_provider_event_created, latest_provider_event_ref
      FROM workspace_subscriptions
      WHERE workspace_id = ${sqlValue(workspaceId)}
      LIMIT 1;
    `)[0] ?? null;
  }
}

function mapPrice(row: PriceRow): PaymentPriceRecord {
  return {
    provider: row.provider,
    planKey: row.plan_key,
    providerPriceRef: row.provider_price_ref,
    active: Boolean(row.active),
  };
}

function mapCustomer(row: CustomerRow): PaymentCustomerRecord {
  return {
    workspaceId: Number(row.workspace_id),
    provider: row.provider,
    providerCustomerRef: row.provider_customer_ref,
    email: row.email,
  };
}

function mapCheckout(row: CheckoutRow): PaymentCheckoutRecord {
  return {
    id: Number(row.id),
    workspaceId: Number(row.workspace_id),
    provider: row.provider,
    idempotencyKey: row.idempotency_key,
    providerSessionRef: row.provider_session_ref,
    planKey: row.plan_key,
    status: row.status,
    checkoutUrl: row.checkout_url,
    expiresAt: row.expires_at,
    completedAt: row.completed_at,
  };
}

function mapSubscription(row: SubscriptionRow): WorkspaceSubscriptionRecord {
  return {
    workspaceId: Number(row.workspace_id),
    planKey: row.plan_key,
    state: row.state,
    periodStartsAt: row.period_starts_at,
    periodEndsAt: row.period_ends_at,
    trialEndsAt: row.trial_ends_at,
    cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
    provider: row.provider,
    providerCustomerRef: row.provider_customer_ref,
    providerSubscriptionRef: row.provider_subscription_ref,
    providerPriceRef: row.provider_price_ref,
    providerSubscriptionItemRef: row.provider_subscription_item_ref,
    pendingPlanKey: row.pending_plan_key,
    graceEndsAt: row.grace_ends_at,
    canceledAt: row.canceled_at,
  };
}

function mapInvoice(row: InvoiceRow): BillingInvoiceRecord {
  return {
    id: Number(row.id),
    workspaceId: Number(row.workspace_id),
    provider: row.provider,
    providerInvoiceRef: row.provider_invoice_ref,
    status: row.status,
    currency: row.currency,
    amountDueMinor: Number(row.amount_due_minor),
    amountPaidMinor: Number(row.amount_paid_minor),
    amountRefundedMinor: Number(row.amount_refunded_minor),
    periodStartsAt: row.period_starts_at,
    periodEndsAt: row.period_ends_at,
    hostedInvoiceUrl: row.hosted_invoice_url,
    invoicePdfUrl: row.invoice_pdf_url,
    dueAt: row.due_at,
    paidAt: row.paid_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
