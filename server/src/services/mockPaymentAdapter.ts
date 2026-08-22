import { createHash } from 'node:crypto';

import {
  type CreateCheckoutInput,
  type PaymentProviderAdapter,
} from './paymentProvider';

export class MockPaymentAdapter implements PaymentProviderAdapter {
  readonly name = 'mock';
  readonly checkoutCompletion = 'immediate' as const;

  async createCustomer(input: {
    workspaceId: number;
    email: string;
    idempotencyKey: string;
  }): Promise<{ id: string }> {
    return { id: `mock_customer_${input.workspaceId}` };
  }

  async createCheckoutSession(input: CreateCheckoutInput): Promise<{
    id: string;
    url: string;
    expiresAt: string | null;
  }> {
    const id = `mock_checkout_${reference(input.idempotencyKey)}`;
    return {
      id,
      url: input.successUrl.replace('{CHECKOUT_SESSION_ID}', id),
      expiresAt: null,
    };
  }

  async createPortalSession(input: {
    customerRef: string;
    returnUrl: string;
  }): Promise<{ url: string }> {
    return { url: input.returnUrl };
  }

  async changeSubscription(): Promise<void> {}

  async scheduleCancellation(): Promise<void> {}
}

function reference(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 20);
}
