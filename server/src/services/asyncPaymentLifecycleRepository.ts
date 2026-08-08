import {
  type AsyncDatabaseAdapter,
  type AsyncDatabaseSession,
} from '../db/asyncAdapter';
import {
  databaseTimestamp,
  nullableDatabaseTimestamp,
} from '../db/databaseTimestamp';
import type {
  ApplySubscriptionStateInput,
  RecordCheckoutInput,
  RecordInvoiceRefundInput,
  UpsertInvoiceInput,
  UpsertRefundInput,
} from './paymentLifecycleStore';
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
  active: boolean | number;
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
  expires_at: string | Date | null;
  completed_at: string | Date | null;
}

interface SubscriptionRow {
  workspace_id: number;
  plan_key: string;
  state: CommercialSubscriptionState;
  period_starts_at: string | Date;
  period_ends_at: string | Date | null;
  trial_ends_at: string | Date | null;
  cancel_at_period_end: boolean | number;
  provider: string;
  provider_customer_ref: string;
  provider_subscription_ref: string;
  provider_price_ref: string;
  provider_subscription_item_ref: string;
  pending_plan_key: string;
  grace_ends_at: string | Date | null;
  canceled_at: string | Date | null;
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
  period_starts_at: string | Date | null;
  period_ends_at: string | Date | null;
  hosted_invoice_url: string;
  invoice_pdf_url: string;
  due_at: string | Date | null;
  paid_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

const CHECKOUT_COLUMNS = [
  'id', 'workspace_id', 'provider', 'idempotency_key', 'provider_session_ref',
  'plan_key', 'status', 'checkout_url', 'expires_at', 'completed_at',
].join(', ');

const SUBSCRIPTION_COLUMNS = [
  'workspace_id', 'plan_key', 'state', 'period_starts_at', 'period_ends_at',
  'trial_ends_at', 'cancel_at_period_end', 'provider', 'provider_customer_ref',
  'provider_subscription_ref', 'provider_price_ref',
  'provider_subscription_item_ref', 'pending_plan_key', 'grace_ends_at',
  'canceled_at', 'latest_provider_event_created', 'latest_provider_event_ref',
].join(', ');

const INVOICE_COLUMNS = [
  'id', 'workspace_id', 'provider', 'provider_invoice_ref', 'status', 'currency',
  'amount_due_minor', 'amount_paid_minor', 'amount_refunded_minor',
  'period_starts_at', 'period_ends_at', 'hosted_invoice_url', 'invoice_pdf_url',
  'due_at', 'paid_at', 'created_at', 'updated_at',
].join(', ');

export class AsyncPaymentLifecycleRepository {
  constructor(
    private readonly database: AsyncDatabaseAdapter,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async configurePrice(provider: string, planKey: string, priceRef: string): Promise<PaymentPriceRecord> {
    await this.database.execute({
      text: `
        INSERT INTO payment_prices (provider, plan_key, provider_price_ref)
        VALUES ($1, $2, $3)
        ON CONFLICT(provider, plan_key) DO UPDATE SET
          provider_price_ref = excluded.provider_price_ref,
          active = TRUE, updated_at = CURRENT_TIMESTAMP;
      `,
      values: [provider, planKey, priceRef],
    });
    const price = await this.priceForPlan(provider, planKey);
    if (!price) throw new Error('payment price could not be loaded');
    return price;
  }

  async priceForPlan(provider: string, planKey: string): Promise<PaymentPriceRecord | null> {
    const rows = await this.database.query<PriceRow>({
      text: `
        SELECT provider, plan_key, provider_price_ref, active
        FROM payment_prices
        WHERE provider = $1 AND plan_key = $2 AND active = TRUE LIMIT 1;
      `,
      values: [provider, planKey],
    });
    return rows[0] ? mapPrice(rows[0]) : null;
  }

  async planForPrice(provider: string, priceRef: string): Promise<string | null> {
    const rows = await this.database.query<{ plan_key: string }>({
      text: `
        SELECT plan_key FROM payment_prices
        WHERE provider = $1 AND provider_price_ref = $2 AND active = TRUE LIMIT 1;
      `,
      values: [provider, priceRef],
    });
    return rows[0]?.plan_key ?? null;
  }

  async customer(workspaceId: number, provider: string): Promise<PaymentCustomerRecord | null> {
    const rows = await this.database.query<CustomerRow>({
      text: `
        SELECT workspace_id, provider, provider_customer_ref, email
        FROM payment_customers
        WHERE workspace_id = $1 AND provider = $2 LIMIT 1;
      `,
      values: [workspaceId, provider],
    });
    return rows[0] ? mapCustomer(rows[0]) : null;
  }

  async upsertCustomer(input: PaymentCustomerRecord): Promise<PaymentCustomerRecord> {
    await this.database.execute({
      text: `
        INSERT INTO payment_customers (
          workspace_id, provider, provider_customer_ref, email
        ) VALUES ($1, $2, $3, $4)
        ON CONFLICT(workspace_id, provider) DO UPDATE SET
          provider_customer_ref = excluded.provider_customer_ref,
          email = CASE WHEN excluded.email = '' THEN payment_customers.email ELSE excluded.email END,
          updated_at = CURRENT_TIMESTAMP;
      `,
      values: [input.workspaceId, input.provider, input.providerCustomerRef, input.email],
    });
    const customer = await this.customer(input.workspaceId, input.provider);
    if (!customer) throw new Error('payment customer could not be loaded');
    return customer;
  }

  async workspaceForProviderObject(
    provider: string,
    customerRef: string,
    subscriptionRef = '',
  ): Promise<number | null> {
    const rows = await this.database.query<{ workspace_id: number }>({
      text: `
        SELECT workspace_id FROM payment_customers
        WHERE provider = $1 AND $2 <> '' AND provider_customer_ref = $2
        UNION
        SELECT workspace_id FROM workspace_subscriptions
        WHERE provider = $1 AND $3 <> '' AND provider_subscription_ref = $3
        LIMIT 1;
      `,
      values: [provider, customerRef, subscriptionRef],
    });
    return rows[0] ? Number(rows[0].workspace_id) : null;
  }

  async recordCheckout(input: RecordCheckoutInput): Promise<PaymentCheckoutRecord> {
    await this.database.execute({
      text: `
        INSERT INTO payment_checkout_sessions (
          workspace_id, provider, idempotency_key, provider_session_ref,
          plan_key, checkout_url, created_by_user_id, expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT(workspace_id, provider, idempotency_key) DO NOTHING;
      `,
      values: [
        input.workspaceId,
        input.provider,
        input.idempotencyKey,
        input.providerSessionRef,
        input.planKey,
        input.checkoutUrl,
        input.createdByUserId,
        input.expiresAt ?? null,
      ],
    });
    const checkout = await this.checkoutByKey(input.workspaceId, input.provider, input.idempotencyKey);
    if (!checkout) throw new Error('checkout session could not be loaded');
    return checkout;
  }

  async checkoutByKey(
    workspaceId: number,
    provider: string,
    key: string,
  ): Promise<PaymentCheckoutRecord | null> {
    const rows = await this.database.query<CheckoutRow>({
      text: `
        SELECT ${CHECKOUT_COLUMNS} FROM payment_checkout_sessions
        WHERE workspace_id = $1 AND provider = $2 AND idempotency_key = $3 LIMIT 1;
      `,
      values: [workspaceId, provider, key],
    });
    return rows[0] ? mapCheckout(rows[0]) : null;
  }

  async completeCheckout(provider: string, sessionRef: string): Promise<void> {
    await this.database.execute({
      text: `
        UPDATE payment_checkout_sessions
        SET status = 'complete', completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
          updated_at = CURRENT_TIMESTAMP
        WHERE provider = $1 AND provider_session_ref = $2;
      `,
      values: [provider, sessionRef],
    });
  }

  markPendingPlan(workspaceId: number, planKey: string): Promise<void> {
    return this.database.transaction(async (session) => {
      await this.lockWorkspace(session, workspaceId);
      await ensureBaseline(session, workspaceId);
      const result = await session.execute({
        text: `
          UPDATE workspace_subscriptions
          SET pending_plan_key = $2, updated_at = CURRENT_TIMESTAMP
          WHERE workspace_id = $1;
        `,
        values: [workspaceId, planKey],
      });
      if (result.rowCount !== 1) throw new Error('pending subscription plan was not updated');
    });
  }

  receiveWebhook(
    provider: string,
    event: PaymentWebhookEvent,
    rawPayload: string,
    signatureTimestamp: number | null,
  ): Promise<boolean> {
    const receivedAt = this.now();
    const leaseExpiredAt = new Date(receivedAt.getTime() - 5 * 60 * 1000).toISOString();
    return this.database.transaction(async (session) => {
      const inserted = await session.query<{ id: number }>({
        text: `
          INSERT INTO payment_webhook_events (
            provider, provider_event_ref, event_type, livemode, api_version,
            payload_json, signature_timestamp, object_created_at, received_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT(provider, provider_event_ref) DO NOTHING
          RETURNING id;
        `,
        values: [
          provider,
          event.id,
          event.type,
          Boolean(event.livemode),
          event.api_version ?? '',
          rawPayload,
          signatureTimestamp,
          event.created,
          receivedAt.toISOString(),
        ],
      });
      if (inserted[0]) return true;
      const reclaimed = await session.query<{ id: number }>({
        text: `
          UPDATE payment_webhook_events
          SET status = 'received', attempts = attempts + 1, error = '',
            payload_json = $3, signature_timestamp = $4, received_at = $5,
            processed_at = NULL
          WHERE provider = $1 AND provider_event_ref = $2
            AND (status = 'failed' OR (status = 'received' AND received_at <= $6))
          RETURNING id;
        `,
        values: [
          provider,
          event.id,
          rawPayload,
          signatureTimestamp,
          receivedAt.toISOString(),
          leaseExpiredAt,
        ],
      });
      return Boolean(reclaimed[0]);
    });
  }

  async finishWebhook(
    provider: string,
    eventRef: string,
    status: 'processed' | 'ignored' | 'failed',
    workspaceId: number | null,
    error = '',
  ): Promise<void> {
    const result = await this.database.execute({
      text: `
        UPDATE payment_webhook_events
        SET status = $3, workspace_id = $4, error = $5, processed_at = $6
        WHERE provider = $1 AND provider_event_ref = $2;
      `,
      values: [provider, eventRef, status, workspaceId, error.slice(0, 2000), this.now().toISOString()],
    });
    if (result.rowCount !== 1) throw new Error('payment webhook event was not finalized');
  }

  subscription(workspaceId: number): Promise<WorkspaceSubscriptionRecord> {
    return this.database.transaction(async (session) => {
      await this.lockWorkspace(session, workspaceId);
      await ensureBaseline(session, workspaceId);
      const row = await subscriptionRow(session, workspaceId);
      if (!row) throw new Error('workspace subscription could not be loaded');
      return mapSubscription(row);
    });
  }

  applySubscriptionState(input: ApplySubscriptionStateInput): Promise<boolean> {
    return this.database.transaction(async (session) => {
      await this.lockWorkspace(session, input.workspaceId);
      await ensureBaseline(session, input.workspaceId);
      const current = await subscriptionRow(session, input.workspaceId);
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
      const updated = await session.execute({
        text: `
          UPDATE workspace_subscriptions
          SET plan_key = $2, state = $3, period_starts_at = $4,
            period_ends_at = $5, trial_ends_at = $6, cancel_at_period_end = $7,
            provider = $8, provider_customer_ref = $9,
            provider_subscription_ref = $10, provider_price_ref = $11,
            provider_subscription_item_ref = $12, pending_plan_key = '',
            grace_ends_at = $13, canceled_at = $14,
            latest_provider_event_created = $15,
            latest_provider_event_ref = $16, updated_at = CURRENT_TIMESTAMP
          WHERE workspace_id = $1;
        `,
        values: [
          input.workspaceId,
          input.planKey,
          input.state,
          input.periodStartsAt ?? current.period_starts_at,
          input.periodEndsAt ?? current.period_ends_at,
          input.trialEndsAt ?? current.trial_ends_at,
          input.cancelAtPeriodEnd ?? Boolean(current.cancel_at_period_end),
          input.provider,
          input.customerRef ?? current.provider_customer_ref,
          input.subscriptionRef ?? current.provider_subscription_ref,
          input.priceRef ?? current.provider_price_ref,
          input.subscriptionItemRef ?? current.provider_subscription_item_ref,
          input.graceEndsAt ?? null,
          canceledAt,
          input.eventCreated,
          input.eventRef,
        ],
      });
      if (updated.rowCount !== 1) throw new Error('subscription state was not updated');
      await session.execute({
        text: `
          INSERT INTO subscription_state_events (
            workspace_id, provider, provider_event_ref, from_state, to_state,
            plan_key, effective_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7);
        `,
        values: [
          input.workspaceId,
          input.provider,
          input.eventRef,
          current.state,
          input.state,
          input.planKey,
          effectiveAt,
        ],
      });
      return true;
    });
  }

  async upsertInvoice(input: UpsertInvoiceInput): Promise<void> {
    await this.database.execute({
      text: `
        INSERT INTO billing_invoices (
          workspace_id, provider, provider_invoice_ref, provider_customer_ref,
          provider_subscription_ref, status, currency, amount_due_minor,
          amount_paid_minor, amount_refunded_minor, period_starts_at,
          period_ends_at, hosted_invoice_url, invoice_pdf_url, due_at, paid_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        ON CONFLICT(provider, provider_invoice_ref) DO UPDATE SET
          provider_customer_ref = excluded.provider_customer_ref,
          provider_subscription_ref = excluded.provider_subscription_ref,
          status = excluded.status, currency = excluded.currency,
          amount_due_minor = excluded.amount_due_minor,
          amount_paid_minor = excluded.amount_paid_minor,
          amount_refunded_minor = excluded.amount_refunded_minor,
          period_starts_at = excluded.period_starts_at,
          period_ends_at = excluded.period_ends_at,
          hosted_invoice_url = excluded.hosted_invoice_url,
          invoice_pdf_url = excluded.invoice_pdf_url,
          due_at = excluded.due_at, paid_at = excluded.paid_at,
          updated_at = CURRENT_TIMESTAMP;
      `,
      values: [
        input.workspaceId,
        input.provider,
        input.invoiceRef,
        input.customerRef ?? '',
        input.subscriptionRef ?? '',
        input.status,
        input.currency ?? 'usd',
        input.amountDueMinor ?? 0,
        input.amountPaidMinor ?? 0,
        input.amountRefundedMinor ?? 0,
        input.periodStartsAt ?? null,
        input.periodEndsAt ?? null,
        input.hostedInvoiceUrl ?? '',
        input.invoicePdfUrl ?? '',
        input.dueAt ?? null,
        input.paidAt ?? null,
      ],
    });
  }

  async upsertRefund(input: UpsertRefundInput): Promise<void> {
    await this.database.execute({
      text: `
        INSERT INTO billing_refunds (
          workspace_id, provider, provider_refund_ref, provider_payment_ref,
          provider_invoice_ref, status, amount_minor, currency, reason,
          provider_created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT(provider, provider_refund_ref) DO UPDATE SET
          provider_payment_ref = excluded.provider_payment_ref,
          provider_invoice_ref = excluded.provider_invoice_ref,
          status = excluded.status, amount_minor = excluded.amount_minor,
          currency = excluded.currency, reason = excluded.reason,
          provider_created_at = excluded.provider_created_at,
          updated_at = CURRENT_TIMESTAMP;
      `,
      values: [
        input.workspaceId,
        input.provider,
        input.refundRef,
        input.paymentRef ?? '',
        input.invoiceRef ?? '',
        input.status,
        input.amountMinor ?? 0,
        input.currency ?? 'usd',
        input.reason ?? '',
        input.providerCreatedAt ?? null,
      ],
    });
  }

  async recordInvoiceRefund(input: RecordInvoiceRefundInput): Promise<void> {
    await this.database.execute({
      text: `
        INSERT INTO billing_invoices (
          workspace_id, provider, provider_invoice_ref, status, amount_refunded_minor
        ) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT(provider, provider_invoice_ref) DO UPDATE SET
          status = excluded.status,
          amount_refunded_minor = excluded.amount_refunded_minor,
          updated_at = CURRENT_TIMESTAMP;
      `,
      values: [
        input.workspaceId,
        input.provider,
        input.invoiceRef,
        input.status,
        input.amountRefundedMinor,
      ],
    });
  }

  async listInvoices(workspaceId: number): Promise<BillingInvoiceRecord[]> {
    const rows = await this.database.query<InvoiceRow>({
      text: `
        SELECT ${INVOICE_COLUMNS} FROM billing_invoices
        WHERE workspace_id = $1 ORDER BY created_at DESC, id DESC;
      `,
      values: [workspaceId],
    });
    return rows.map(mapInvoice);
  }

  private async lockWorkspace(session: AsyncDatabaseSession, workspaceId: number): Promise<void> {
    if (this.database.dialect !== 'postgres') return;
    await session.query({
      text: 'SELECT pg_advisory_xact_lock($1);',
      values: [workspaceId],
    });
  }
}

async function ensureBaseline(session: AsyncDatabaseSession, workspaceId: number): Promise<void> {
  await session.execute({
    text: `
      INSERT INTO workspace_subscriptions (workspace_id, plan_key, state, period_starts_at)
      VALUES ($1, 'free', 'active', CURRENT_TIMESTAMP)
      ON CONFLICT(workspace_id) DO NOTHING;
    `,
    values: [workspaceId],
  });
  await session.execute({
    text: `
      INSERT INTO credit_accounts (workspace_id) VALUES ($1)
      ON CONFLICT(workspace_id) DO NOTHING;
    `,
    values: [workspaceId],
  });
  await session.execute({
    text: `
      INSERT INTO credit_ledger_entries (
        workspace_id, idempotency_key, event_type, available_delta,
        source_type, source_ref
      )
      SELECT $1, $2, 'grant', monthly_credit_grant, 'plan', 'free:initial'
      FROM billing_plans WHERE key = 'free'
      ON CONFLICT(workspace_id, idempotency_key) DO NOTHING;
    `,
    values: [workspaceId, `plan-period:free:${workspaceId}:initial`],
  });
}

async function subscriptionRow(
  session: AsyncDatabaseSession,
  workspaceId: number,
): Promise<SubscriptionRow | null> {
  const rows = await session.query<SubscriptionRow>({
    text: `
      SELECT ${SUBSCRIPTION_COLUMNS} FROM workspace_subscriptions
      WHERE workspace_id = $1 LIMIT 1;
    `,
    values: [workspaceId],
  });
  return rows[0] ?? null;
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
    expiresAt: nullableDatabaseTimestamp(row.expires_at),
    completedAt: nullableDatabaseTimestamp(row.completed_at),
  };
}

function mapSubscription(row: SubscriptionRow): WorkspaceSubscriptionRecord {
  return {
    workspaceId: Number(row.workspace_id),
    planKey: row.plan_key,
    state: row.state,
    periodStartsAt: databaseTimestamp(row.period_starts_at),
    periodEndsAt: nullableDatabaseTimestamp(row.period_ends_at),
    trialEndsAt: nullableDatabaseTimestamp(row.trial_ends_at),
    cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
    provider: row.provider,
    providerCustomerRef: row.provider_customer_ref,
    providerSubscriptionRef: row.provider_subscription_ref,
    providerPriceRef: row.provider_price_ref,
    providerSubscriptionItemRef: row.provider_subscription_item_ref,
    pendingPlanKey: row.pending_plan_key,
    graceEndsAt: nullableDatabaseTimestamp(row.grace_ends_at),
    canceledAt: nullableDatabaseTimestamp(row.canceled_at),
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
    periodStartsAt: nullableDatabaseTimestamp(row.period_starts_at),
    periodEndsAt: nullableDatabaseTimestamp(row.period_ends_at),
    hostedInvoiceUrl: row.hosted_invoice_url,
    invoicePdfUrl: row.invoice_pdf_url,
    dueAt: nullableDatabaseTimestamp(row.due_at),
    paidAt: nullableDatabaseTimestamp(row.paid_at),
    createdAt: databaseTimestamp(row.created_at),
    updatedAt: databaseTimestamp(row.updated_at),
  };
}
