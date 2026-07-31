import {
  PaymentProviderError,
  type CreateCheckoutInput,
  type PaymentProviderAdapter,
} from './paymentProvider';

interface StripeObject {
  id?: unknown;
  url?: unknown;
  expires_at?: unknown;
  error?: { message?: unknown; code?: unknown };
}

export class StripePaymentAdapter implements PaymentProviderAdapter {
  readonly name = 'stripe';

  constructor(
    private readonly secretKey: string,
    private readonly request: typeof fetch = fetch,
    private readonly apiBaseUrl = 'https://api.stripe.com',
    private readonly apiVersion?: string,
  ) {
    if (!secretKey.trim()) throw new Error('Stripe secret key is required');
  }

  async createCustomer(input: {
    workspaceId: number;
    email: string;
    idempotencyKey: string;
  }): Promise<{ id: string }> {
    const result = await this.post('/v1/customers', {
      email: input.email,
      'metadata[workspace_id]': String(input.workspaceId),
    }, input.idempotencyKey);
    return { id: requiredString(result.id, 'Stripe customer id') };
  }

  async createCheckoutSession(input: CreateCheckoutInput): Promise<{
    id: string;
    url: string;
    expiresAt: string | null;
  }> {
    const result = await this.post('/v1/checkout/sessions', {
      mode: 'subscription',
      customer: input.customerRef,
      client_reference_id: String(input.workspaceId),
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      'line_items[0][price]': input.priceRef,
      'line_items[0][quantity]': '1',
      'metadata[workspace_id]': String(input.workspaceId),
      'metadata[plan_key]': input.planKey,
      'subscription_data[metadata][workspace_id]': String(input.workspaceId),
      'subscription_data[metadata][plan_key]': input.planKey,
    }, input.idempotencyKey);
    const expiresAt = typeof result.expires_at === 'number'
      ? new Date(result.expires_at * 1000).toISOString()
      : null;
    return {
      id: requiredString(result.id, 'Stripe checkout session id'),
      url: requiredString(result.url, 'Stripe checkout URL'),
      expiresAt,
    };
  }

  async createPortalSession(input: {
    customerRef: string;
    returnUrl: string;
  }): Promise<{ url: string }> {
    const result = await this.post('/v1/billing_portal/sessions', {
      customer: input.customerRef,
      return_url: input.returnUrl,
    });
    return { url: requiredString(result.url, 'Stripe portal URL') };
  }

  async changeSubscription(input: {
    subscriptionRef: string;
    subscriptionItemRef: string;
    priceRef: string;
    idempotencyKey: string;
  }): Promise<void> {
    await this.post(`/v1/subscriptions/${encodeURIComponent(input.subscriptionRef)}`, {
      'items[0][id]': input.subscriptionItemRef,
      'items[0][price]': input.priceRef,
      payment_behavior: 'pending_if_incomplete',
      proration_behavior: 'always_invoice',
    }, input.idempotencyKey);
  }

  async scheduleCancellation(input: {
    subscriptionRef: string;
    idempotencyKey: string;
  }): Promise<void> {
    await this.post(`/v1/subscriptions/${encodeURIComponent(input.subscriptionRef)}`, {
      cancel_at_period_end: 'true',
    }, input.idempotencyKey);
  }

  private async post(
    path: string,
    values: Record<string, string>,
    idempotencyKey?: string,
  ): Promise<StripeObject> {
    const response = await this.request(`${this.apiBaseUrl}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.secretKey}`,
        'content-type': 'application/x-www-form-urlencoded',
        ...(this.apiVersion ? { 'stripe-version': this.apiVersion } : {}),
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      body: new URLSearchParams(values).toString(),
    });
    const payload = await response.json() as StripeObject;
    if (!response.ok) {
      throw new PaymentProviderError(
        typeof payload.error?.code === 'string' ? payload.error.code : 'STRIPE_REQUEST_FAILED',
        typeof payload.error?.message === 'string'
          ? payload.error.message
          : `Stripe request failed with HTTP ${response.status}`,
        502,
      );
    }
    return payload;
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new PaymentProviderError('STRIPE_RESPONSE_INVALID', `${label} is missing`);
  }
  return value;
}
