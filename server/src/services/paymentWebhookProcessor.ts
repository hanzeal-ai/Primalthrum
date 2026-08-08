import { type PaymentBillingStore } from './paymentBillingStore';
import { type PaymentLifecycleStore } from './paymentLifecycleStore';
import {
  PaymentError,
  type CommercialSubscriptionState,
  type PaymentWebhookEvent,
  type PaymentWebhookResult,
} from './paymentTypes';

const PROVIDER = 'stripe';

export class PaymentWebhookProcessor {
  constructor(
    private readonly payments: PaymentLifecycleStore,
    private readonly billing: PaymentBillingStore,
    private readonly gracePeriodDays = 7,
  ) {}

  async process(
    event: PaymentWebhookEvent,
    rawPayload: string,
    signatureTimestamp: number | null,
  ): Promise<PaymentWebhookResult> {
    validateEvent(event);
    if (!await this.payments.receiveWebhook(PROVIDER, event, rawPayload, signatureTimestamp)) {
      return { eventId: event.id, status: 'duplicate', workspaceId: null };
    }

    try {
      const workspaceId = await this.dispatch(event);
      const status = workspaceId === null ? 'ignored' : 'processed';
      await this.payments.finishWebhook(PROVIDER, event.id, status, workspaceId);
      return { eventId: event.id, status, workspaceId };
    } catch (error) {
      await this.payments.finishWebhook(
        PROVIDER,
        event.id,
        'failed',
        null,
        error instanceof Error ? error.message : 'webhook processing failed',
      );
      throw error;
    }
  }

  private async dispatch(event: PaymentWebhookEvent): Promise<number | null> {
    switch (event.type) {
      case 'checkout.session.completed':
        return this.checkoutCompleted(event);
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        return this.subscriptionChanged(event);
      case 'invoice.paid':
      case 'invoice.payment_failed':
      case 'invoice.updated':
        return this.invoiceChanged(event);
      case 'charge.refunded':
        return this.chargeRefunded(event);
      case 'refund.created':
      case 'refund.updated':
        return this.refundChanged(event);
      default:
        return null;
    }
  }

  private async checkoutCompleted(event: PaymentWebhookEvent): Promise<number | null> {
    const object = event.data.object;
    const workspaceId = await this.workspaceId(object);
    if (workspaceId === null) return null;
    const customerRef = stringValue(object.customer);
    if (customerRef) {
      await this.payments.upsertCustomer({
        workspaceId,
        provider: PROVIDER,
        providerCustomerRef: customerRef,
        email: nestedString(object, 'customer_details', 'email'),
      });
    }
    const sessionRef = requiredString(object.id, 'checkout session id');
    await this.payments.completeCheckout(PROVIDER, sessionRef);
    return workspaceId;
  }

  private async subscriptionChanged(event: PaymentWebhookEvent): Promise<number | null> {
    const object = event.data.object;
    const customerRef = stringValue(object.customer);
    const subscriptionRef = requiredString(object.id, 'subscription id');
    const workspaceId = await this.workspaceId(object, customerRef, subscriptionRef);
    if (workspaceId === null) return null;
    const priceRef = nestedString(object, 'items', 'data', 0, 'price', 'id');
    const planKey = await this.planKey(object, priceRef, workspaceId);
    const providerState = event.type === 'customer.subscription.deleted'
      ? 'canceled'
      : stringValue(object.status);
    const state = mapSubscriptionState(providerState, Boolean(object.cancel_at_period_end));
    const period = subscriptionPeriod(object);
    if (customerRef) {
      await this.payments.upsertCustomer({
        workspaceId,
        provider: PROVIDER,
        providerCustomerRef: customerRef,
        email: '',
      });
    }
    await this.payments.applySubscriptionState({
      workspaceId,
      provider: PROVIDER,
      eventRef: event.id,
      eventCreated: event.created,
      state,
      planKey,
      customerRef,
      subscriptionRef,
      priceRef,
      subscriptionItemRef: nestedString(object, 'items', 'data', 0, 'id'),
      periodStartsAt: unixTimestamp(period.start),
      periodEndsAt: unixTimestamp(period.end),
      trialEndsAt: unixTimestamp(numberValue(object.trial_end)),
      cancelAtPeriodEnd: Boolean(object.cancel_at_period_end),
      graceEndsAt: state === 'past_due' ? this.graceEnd(event.created) : null,
    });
    return workspaceId;
  }

  private async invoiceChanged(event: PaymentWebhookEvent): Promise<number | null> {
    const object = event.data.object;
    const customerRef = stringValue(object.customer);
    const subscriptionRef = invoiceSubscriptionRef(object);
    const workspaceId = await this.workspaceId(object, customerRef, subscriptionRef);
    if (workspaceId === null) return null;
    const period = invoicePeriod(object);
    const paid = event.type === 'invoice.paid' || Boolean(object.paid);
    await this.payments.upsertInvoice({
      workspaceId,
      provider: PROVIDER,
      invoiceRef: requiredString(object.id, 'invoice id'),
      customerRef,
      subscriptionRef,
      status: stringValue(object.status) || (paid ? 'paid' : 'open'),
      currency: stringValue(object.currency) || 'usd',
      amountDueMinor: numberValue(object.amount_due),
      amountPaidMinor: numberValue(object.amount_paid),
      amountRefundedMinor: numberValue(object.amount_refunded),
      periodStartsAt: unixTimestamp(period.start),
      periodEndsAt: unixTimestamp(period.end),
      hostedInvoiceUrl: stringValue(object.hosted_invoice_url),
      invoicePdfUrl: stringValue(object.invoice_pdf),
      dueAt: unixTimestamp(numberValue(object.due_date)),
      paidAt: unixTimestamp(nestedNumber(object, 'status_transitions', 'paid_at')),
    });

    const subscription = await this.payments.subscription(workspaceId);
    const invoicePriceRef = nestedString(object, 'lines', 'data', 0, 'price', 'id')
      || nestedString(object, 'lines', 'data', 0, 'pricing', 'price_details', 'price');
    const invoicePlanKey = invoicePriceRef
      ? await this.payments.planForPrice(PROVIDER, invoicePriceRef) ?? subscription.planKey
      : subscription.planKey;
    if (event.type === 'invoice.payment_failed') {
      await this.payments.applySubscriptionState({
        workspaceId,
        provider: PROVIDER,
        eventRef: event.id,
        eventCreated: event.created,
        state: 'past_due',
        planKey: invoicePlanKey,
        customerRef,
        subscriptionRef,
        graceEndsAt: this.graceEnd(event.created),
      });
      return workspaceId;
    }
    if (!paid) return workspaceId;

    await this.payments.applySubscriptionState({
      workspaceId,
      provider: PROVIDER,
      eventRef: event.id,
      eventCreated: event.created,
      state: subscription.cancelAtPeriodEnd ? 'cancel_at_period_end' : 'active',
      planKey: invoicePlanKey,
      customerRef,
      subscriptionRef,
      periodStartsAt: unixTimestamp(period.start),
      periodEndsAt: unixTimestamp(period.end),
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    });
    const plan = (await this.billing.listPlans())
      .find((candidate) => candidate.key === invoicePlanKey);
    if (plan && plan.monthlyCreditGrant > 0) {
      const invoiceRef = requiredString(object.id, 'invoice id');
      await this.billing.grantCredits({
        workspaceId,
        amount: plan.monthlyCreditGrant,
        idempotencyKey: `invoice:${invoiceRef}`,
        sourceType: 'invoice',
        sourceRef: invoiceRef,
      });
    }
    return workspaceId;
  }

  private async chargeRefunded(event: PaymentWebhookEvent): Promise<number | null> {
    const object = event.data.object;
    const workspaceId = await this.workspaceId(object, stringValue(object.customer));
    if (workspaceId === null) return null;
    const invoiceRef = stringValue(object.invoice);
    const refunds = nestedArray(object, 'refunds', 'data');
    for (const refund of refunds) {
      await this.storeRefund(workspaceId, refund, invoiceRef);
    }
    const amount = numberValue(object.amount);
    const refunded = numberValue(object.amount_refunded);
    if (invoiceRef) {
      await this.payments.recordInvoiceRefund({
        workspaceId,
        provider: PROVIDER,
        invoiceRef,
        status: refunded >= amount && amount > 0 ? 'refunded' : 'paid',
        amountRefundedMinor: refunded,
      });
    }
    const subscription = await this.payments.subscription(workspaceId);
    if (
      refunded >= amount
      && amount > 0
      && ['canceled', 'cancel_at_period_end'].includes(subscription.state)
    ) {
      await this.payments.applySubscriptionState({
        workspaceId,
        provider: PROVIDER,
        eventRef: event.id,
        eventCreated: event.created,
        state: 'refunded',
        planKey: subscription.planKey,
      });
    }
    return workspaceId;
  }

  private async refundChanged(event: PaymentWebhookEvent): Promise<number | null> {
    const object = event.data.object;
    const workspaceId = await this.workspaceId(object);
    if (workspaceId === null) return null;
    await this.storeRefund(workspaceId, object, stringValue(object.invoice));
    return workspaceId;
  }

  private async storeRefund(
    workspaceId: number,
    refund: Record<string, unknown>,
    invoiceRef: string,
  ): Promise<void> {
    await this.payments.upsertRefund({
      workspaceId,
      provider: PROVIDER,
      refundRef: requiredString(refund.id, 'refund id'),
      paymentRef: stringValue(refund.payment_intent) || stringValue(refund.charge),
      invoiceRef,
      status: stringValue(refund.status) || 'pending',
      amountMinor: numberValue(refund.amount),
      currency: stringValue(refund.currency) || 'usd',
      reason: stringValue(refund.reason),
      providerCreatedAt: unixTimestamp(numberValue(refund.created)),
    });
  }

  private async workspaceId(
    object: Record<string, unknown>,
    customerRef = '',
    subscriptionRef = '',
  ): Promise<number | null> {
    const metadataId = Number(nestedString(object, 'metadata', 'workspace_id'));
    if (Number.isSafeInteger(metadataId) && metadataId > 0) return metadataId;
    return this.payments.workspaceForProviderObject(PROVIDER, customerRef, subscriptionRef);
  }

  private async planKey(
    object: Record<string, unknown>,
    priceRef: string,
    workspaceId: number,
  ): Promise<string> {
    const metadataPlan = nestedString(object, 'metadata', 'plan_key');
    const mappedPlan = priceRef ? await this.payments.planForPrice(PROVIDER, priceRef) : null;
    const subscription = mappedPlan || metadataPlan
      ? null
      : await this.payments.subscription(workspaceId);
    const planKey = mappedPlan || metadataPlan || subscription?.planKey || '';
    if (!(await this.billing.listPlans()).some((plan) => plan.key === planKey)) {
      throw new PaymentError('PAYMENT_PLAN_UNKNOWN', 'payment event references an unknown plan');
    }
    return planKey;
  }

  private graceEnd(eventCreated: number): string {
    return new Date(eventCreated * 1000 + this.gracePeriodDays * 86_400_000).toISOString();
  }
}

function validateEvent(event: PaymentWebhookEvent): void {
  if (!event || typeof event !== 'object') throw new PaymentError('WEBHOOK_EVENT_INVALID', 'event is required');
  requiredString(event.id, 'event id');
  requiredString(event.type, 'event type');
  if (!Number.isSafeInteger(event.created) || event.created <= 0) {
    throw new PaymentError('WEBHOOK_EVENT_INVALID', 'event created timestamp is invalid');
  }
  if (!event.data?.object || typeof event.data.object !== 'object') {
    throw new PaymentError('WEBHOOK_EVENT_INVALID', 'event data object is required');
  }
}

function mapSubscriptionState(status: string, cancelAtPeriodEnd: boolean): CommercialSubscriptionState {
  if (status === 'trialing') return 'trialing';
  if (status === 'active') return cancelAtPeriodEnd ? 'cancel_at_period_end' : 'active';
  if (status === 'past_due' || status === 'unpaid' || status === 'incomplete') return 'past_due';
  if (status === 'paused') return 'restricted';
  if (status === 'canceled' || status === 'incomplete_expired') return 'canceled';
  throw new PaymentError('PAYMENT_SUBSCRIPTION_STATE_UNKNOWN', `unsupported subscription state ${status}`);
}

function subscriptionPeriod(object: Record<string, unknown>): { start: number; end: number } {
  return {
    start: numberValue(object.current_period_start)
      || nestedNumber(object, 'items', 'data', 0, 'current_period_start'),
    end: numberValue(object.current_period_end)
      || nestedNumber(object, 'items', 'data', 0, 'current_period_end'),
  };
}

function invoicePeriod(object: Record<string, unknown>): { start: number; end: number } {
  return {
    start: numberValue(object.period_start)
      || nestedNumber(object, 'lines', 'data', 0, 'period', 'start'),
    end: numberValue(object.period_end)
      || nestedNumber(object, 'lines', 'data', 0, 'period', 'end'),
  };
}

function invoiceSubscriptionRef(object: Record<string, unknown>): string {
  return stringValue(object.subscription)
    || nestedString(object, 'parent', 'subscription_details', 'subscription');
}

function requiredString(value: unknown, label: string): string {
  const parsed = stringValue(value);
  if (!parsed) throw new PaymentError('WEBHOOK_EVENT_INVALID', `${label} is required`);
  return parsed;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function unixTimestamp(value: number): string | null {
  return value > 0 ? new Date(value * 1000).toISOString() : null;
}

function nestedString(object: Record<string, unknown>, ...path: Array<string | number>): string {
  return stringValue(nestedValue(object, path));
}

function nestedNumber(object: Record<string, unknown>, ...path: Array<string | number>): number {
  return numberValue(nestedValue(object, path));
}

function nestedArray(object: Record<string, unknown>, ...path: Array<string | number>): Record<string, unknown>[] {
  const value = nestedValue(object, path);
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
    : [];
}

function nestedValue(object: Record<string, unknown>, path: Array<string | number>): unknown {
  let value: unknown = object;
  for (const segment of path) {
    if (typeof segment === 'number') {
      if (!Array.isArray(value)) return undefined;
      value = value[segment];
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}
