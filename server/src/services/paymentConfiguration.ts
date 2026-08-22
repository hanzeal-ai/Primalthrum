import { MockPaymentAdapter } from './mockPaymentAdapter';
import { type PaymentProviderAdapter } from './paymentProvider';
import { StripePaymentAdapter } from './stripePaymentAdapter';

export interface PaymentConfiguration {
  adapter?: PaymentProviderAdapter;
  priceRefs: Record<string, string>;
}

export function createPaymentConfiguration(
  environment: NodeJS.ProcessEnv,
  request: typeof fetch = fetch,
): PaymentConfiguration {
  const stripeSecretKey = environment.STRIPE_SECRET_KEY?.trim();
  const configuredProvider = environment.PAYMENT_PROVIDER?.trim().toLowerCase();
  const provider = configuredProvider
    || (stripeSecretKey ? 'stripe' : environment.NODE_ENV === 'production' ? 'disabled' : 'mock');

  if (provider === 'disabled') return { priceRefs: {} };
  if (provider === 'mock') {
    return {
      adapter: new MockPaymentAdapter(),
      priceRefs: paidPlanKeys('mock_price'),
    };
  }
  if (provider !== 'stripe') {
    throw new Error('PAYMENT_PROVIDER must be disabled, mock, or stripe');
  }
  if (!stripeSecretKey) throw new Error('STRIPE_SECRET_KEY is required when PAYMENT_PROVIDER=stripe');
  return {
    adapter: new StripePaymentAdapter(
      stripeSecretKey,
      request,
      'https://api.stripe.com',
      environment.STRIPE_API_VERSION,
    ),
    priceRefs: Object.fromEntries(
      [
        ['pro', environment.STRIPE_PRICE_PRO],
        ['team', environment.STRIPE_PRICE_TEAM],
        ['business', environment.STRIPE_PRICE_BUSINESS],
        ['enterprise', environment.STRIPE_PRICE_ENTERPRISE],
      ].filter((entry): entry is [string, string] => Boolean(entry[1]?.trim())),
    ),
  };
}

function paidPlanKeys(prefix: string): Record<string, string> {
  return Object.fromEntries(
    ['pro', 'team', 'business', 'enterprise'].map((planKey) => [planKey, `${prefix}_${planKey}`]),
  );
}
