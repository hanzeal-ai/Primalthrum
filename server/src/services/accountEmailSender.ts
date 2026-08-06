import { renderAccountEmail } from './accountEmailTemplates';

export interface AccountEmailMessage {
  id: number;
  template: 'verify_email' | 'reset_password' | 'workspace_invitation';
  recipientEmail: string;
  payload: Record<string, unknown>;
}

export interface AccountEmailDeliveryReceipt {
  provider: string;
  providerMessageId: string;
}

export interface AccountEmailSender {
  send(message: AccountEmailMessage): Promise<AccountEmailDeliveryReceipt>;
}

export class AccountEmailDeliveryError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'AccountEmailDeliveryError';
  }
}

export class HttpAccountEmailSender implements AccountEmailSender {
  readonly provider = 'http';

  constructor(
    private readonly endpoint: string,
    private readonly token = '',
    private readonly from = '',
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {
    new URL(endpoint);
  }

  async send(message: AccountEmailMessage): Promise<AccountEmailDeliveryReceipt> {
    const response = await sendRequest(this.fetchImplementation, this.endpoint, this.timeoutMs, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey(message.id),
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify({ ...message, from: this.from, ...renderAccountEmail(message) }),
    });
    const body = await responseJson(response);
    const providerMessageId = messageId(response, body);
    if (!providerMessageId) {
      throw new AccountEmailDeliveryError('email provider response is missing a message id', false);
    }
    return { provider: this.provider, providerMessageId };
  }
}

export class ResendAccountEmailSender implements AccountEmailSender {
  readonly provider = 'resend';

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly endpoint = 'https://api.resend.com/emails',
    private readonly timeoutMs = 10_000,
  ) {
    if (!apiKey.trim()) throw new Error('Resend API key is required');
    if (!from.trim()) throw new Error('transactional email sender is required');
    new URL(endpoint);
  }

  async send(message: AccountEmailMessage): Promise<AccountEmailDeliveryReceipt> {
    const rendered = renderAccountEmail(message);
    const response = await sendRequest(this.fetchImplementation, this.endpoint, this.timeoutMs, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey(message.id),
      },
      body: JSON.stringify({
        from: this.from,
        to: [message.recipientEmail],
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
      }),
    });
    const body = await responseJson(response);
    const providerMessageId = messageId(response, body);
    if (!providerMessageId) {
      throw new AccountEmailDeliveryError('Resend response is missing a message id', false);
    }
    return { provider: this.provider, providerMessageId };
  }
}

async function sendRequest(
  fetchImplementation: typeof fetch,
  endpoint: string,
  timeoutMs: number,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImplementation(endpoint, { ...init, signal: controller.signal });
    if (!response.ok) {
      const body = await responseJson(response);
      const detail = stringValue(body.message) || stringValue(body.error)
        || `email delivery failed with status ${response.status}`;
      throw new AccountEmailDeliveryError(
        detail.slice(0, 500),
        retryableStatus(response.status),
        retryAfterMs(response.headers.get('retry-after')),
      );
    }
    return response;
  } catch (error) {
    if (error instanceof AccountEmailDeliveryError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new AccountEmailDeliveryError('email provider request timed out', true);
    }
    throw new AccountEmailDeliveryError(
      error instanceof Error ? error.message : 'email provider request failed',
      true,
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return {};
  try {
    const value = await response.json();
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function messageId(response: Response, body: Record<string, unknown>): string {
  const data = body.data && typeof body.data === 'object' && !Array.isArray(body.data)
    ? body.data as Record<string, unknown>
    : {};
  return [body.id, body.messageId, data.id, response.headers.get('x-message-id')]
    .find((value): value is string => typeof value === 'string' && value.length > 0 && value.length <= 255)
    ?? '';
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60 * 60 * 1000);
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return undefined;
  return Math.min(Math.max(timestamp - Date.now(), 0), 60 * 60 * 1000);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function idempotencyKey(id: number): string {
  return `primalthrum-account-email-${id}`;
}
