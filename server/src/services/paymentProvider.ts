export interface CreateCheckoutInput {
  workspaceId: number;
  planKey: string;
  priceRef: string;
  customerRef: string;
  successUrl: string;
  cancelUrl: string;
  idempotencyKey: string;
}

export interface PaymentProviderAdapter {
  readonly name: string;
  createCustomer(input: {
    workspaceId: number;
    email: string;
    idempotencyKey: string;
  }): Promise<{ id: string }>;
  createCheckoutSession(input: CreateCheckoutInput): Promise<{
    id: string;
    url: string;
    expiresAt: string | null;
  }>;
  createPortalSession(input: {
    customerRef: string;
    returnUrl: string;
  }): Promise<{ url: string }>;
  changeSubscription(input: {
    subscriptionRef: string;
    subscriptionItemRef: string;
    priceRef: string;
    idempotencyKey: string;
  }): Promise<void>;
  scheduleCancellation(input: {
    subscriptionRef: string;
    idempotencyKey: string;
  }): Promise<void>;
}

export class PaymentProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}
