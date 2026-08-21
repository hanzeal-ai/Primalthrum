import {
  type CreateCheckoutInput,
  type PaymentProviderAdapter,
} from '../../src/services/paymentProvider';

export const BROWSER_E2E_WEBHOOK_SECRET = 'whsec_browser_e2e_secret';

export class BrowserE2ePaymentAdapter implements PaymentProviderAdapter {
  readonly name = 'stripe';

  constructor(private readonly publicAppUrl: string) {
  }

  async createCustomer(input: {
    workspaceId: number;
  }): Promise<{ id: string }> {
    return { id: `cus_e2e_${input.workspaceId}` };
  }

  async createCheckoutSession(input: CreateCheckoutInput): Promise<{
    id: string;
    url: string;
    expiresAt: string | null;
  }> {
    const id = `cs_e2e_${input.workspaceId}_${input.planKey}`;
    return {
      id,
      url: `${this.publicAppUrl}/app/billing?checkout=success&session_id=${id}`,
      expiresAt: null,
    };
  }

  async createPortalSession(): Promise<{ url: string }> {
    return { url: `${this.publicAppUrl}/app/billing` };
  }

  async changeSubscription(): Promise<void> {
    return undefined;
  }

  async scheduleCancellation(): Promise<void> {
    return undefined;
  }
}
