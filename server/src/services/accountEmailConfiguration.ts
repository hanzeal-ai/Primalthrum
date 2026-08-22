import {
  HttpAccountEmailSender,
  ResendAccountEmailSender,
  type AccountEmailSender,
} from './accountEmailSender';
import {
  SignedAccountEmailWebhookVerifier,
  type AccountEmailWebhookVerifier,
} from './accountEmailWebhook';
import { MockAccountEmailSender } from './mockAccountEmailSender';

export interface AccountEmailIntegration {
  sender?: AccountEmailSender;
  webhookVerifier?: AccountEmailWebhookVerifier;
  exposePreview: boolean;
  provider: 'disabled' | 'http' | 'mock' | 'resend';
}

export function createAccountEmailIntegration(
  environment: Record<string, string | undefined>,
  fetchImplementation: typeof fetch = fetch,
): AccountEmailIntegration {
  const production = environment.NODE_ENV === 'production';
  const explicitProvider = environment.TRANSACTIONAL_EMAIL_PROVIDER?.trim().toLowerCase();
  const inferredProvider = environment.TRANSACTIONAL_EMAIL_URL?.trim() ? 'http'
    : environment.TRANSACTIONAL_EMAIL_API_KEY?.trim() ? 'resend'
      : '';
  const provider = explicitProvider || inferredProvider || (production ? '' : 'mock');
  if (!provider) {
    if (production) throw new Error('TRANSACTIONAL_EMAIL_PROVIDER is required in production');
    return { provider: 'disabled', exposePreview: true };
  }
  if (provider === 'disabled') {
    return { provider, exposePreview: true };
  }
  if (provider === 'mock') {
    return { provider, exposePreview: true, sender: new MockAccountEmailSender() };
  }
  if (provider !== 'http' && provider !== 'resend') {
    throw new Error('TRANSACTIONAL_EMAIL_PROVIDER must be disabled, mock, http, or resend');
  }

  const from = required(environment.TRANSACTIONAL_EMAIL_FROM, 'TRANSACTIONAL_EMAIL_FROM');
  const webhookSecret = environment.TRANSACTIONAL_EMAIL_WEBHOOK_SECRET?.trim();
  if (production && !webhookSecret) {
    throw new Error('TRANSACTIONAL_EMAIL_WEBHOOK_SECRET is required in production');
  }
  const webhookVerifier = webhookSecret
    ? new SignedAccountEmailWebhookVerifier(provider, webhookSecret)
    : undefined;

  if (provider === 'resend') {
    const apiKey = required(
      environment.TRANSACTIONAL_EMAIL_API_KEY ?? environment.TRANSACTIONAL_EMAIL_TOKEN,
      'TRANSACTIONAL_EMAIL_API_KEY',
    );
    return {
      provider,
      exposePreview: !production,
      sender: new ResendAccountEmailSender(
        apiKey,
        from,
        fetchImplementation,
        environment.TRANSACTIONAL_EMAIL_URL?.trim() || undefined,
      ),
      webhookVerifier,
    };
  }

  return {
    provider,
    exposePreview: !production,
    sender: new HttpAccountEmailSender(
      required(environment.TRANSACTIONAL_EMAIL_URL, 'TRANSACTIONAL_EMAIL_URL'),
      required(environment.TRANSACTIONAL_EMAIL_TOKEN, 'TRANSACTIONAL_EMAIL_TOKEN'),
      from,
      fetchImplementation,
    ),
    webhookVerifier,
  };
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}
