import { createHmac, timingSafeEqual } from 'node:crypto';

import { type AccountEmailProviderEventType } from './accountEmailOutboxRepository';

export interface VerifiedAccountEmailEvent {
  provider: string;
  providerEventId: string;
  providerMessageId: string;
  eventType: AccountEmailProviderEventType;
  occurredAt: string;
}

export interface AccountEmailWebhookVerifier {
  verify(rawBody: string, headers: Record<string, string | string[] | undefined>): VerifiedAccountEmailEvent;
}

export class SignedAccountEmailWebhookVerifier implements AccountEmailWebhookVerifier {
  private readonly key: Buffer;

  constructor(
    private readonly provider: string,
    secret: string,
    private readonly now: () => Date = () => new Date(),
    private readonly toleranceSeconds = 300,
  ) {
    if (!secret.trim()) throw new Error('transactional email webhook secret is required');
    this.key = secret.startsWith('whsec_')
      ? Buffer.from(secret.slice('whsec_'.length), 'base64')
      : Buffer.from(secret, 'utf8');
    if (this.key.length < 16) throw new Error('transactional email webhook secret is too short');
  }

  verify(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): VerifiedAccountEmailEvent {
    const eventId = header(headers, 'svix-id');
    const timestampText = header(headers, 'svix-timestamp');
    const signatures = header(headers, 'svix-signature');
    const timestamp = Number(timestampText);
    if (!eventId || !Number.isInteger(timestamp)) throw new Error('email webhook signature headers are invalid');
    if (Math.abs(Math.floor(this.now().getTime() / 1000) - timestamp) > this.toleranceSeconds) {
      throw new Error('email webhook timestamp is outside the accepted window');
    }
    const expected = createHmac('sha256', this.key)
      .update(`${eventId}.${timestampText}.${rawBody}`)
      .digest();
    const valid = signatures.split(' ').some((signature) => {
      const [version, encoded] = signature.split(',', 2);
      if (version !== 'v1' || !encoded) return false;
      try {
        const supplied = Buffer.from(encoded, 'base64');
        return supplied.length === expected.length && timingSafeEqual(supplied, expected);
      } catch {
        return false;
      }
    });
    if (!valid) throw new Error('email webhook signature is invalid');
    return parseProviderEvent(this.provider, eventId, rawBody);
  }
}

function parseProviderEvent(
  provider: string,
  providerEventId: string,
  rawBody: string,
): VerifiedAccountEmailEvent {
  let value: unknown;
  try {
    value = JSON.parse(rawBody);
  } catch {
    throw new Error('email webhook body is not valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('email webhook body is invalid');
  }
  const event = value as Record<string, unknown>;
  const data = event.data && typeof event.data === 'object' && !Array.isArray(event.data)
    ? event.data as Record<string, unknown>
    : {};
  const providerMessageId = boundedString(data.email_id ?? data.message_id ?? event.messageId, 255);
  const occurredAt = timestamp(event.created_at ?? event.occurredAt);
  return {
    provider,
    providerEventId: boundedString(providerEventId, 255),
    providerMessageId,
    eventType: providerEventType(event.type),
    occurredAt,
  };
}

function providerEventType(value: unknown): AccountEmailProviderEventType {
  const normalized = typeof value === 'string' ? value.replace(/^email\./, '') : '';
  const aliases: Record<string, AccountEmailProviderEventType> = {
    sent: 'accepted',
    accepted: 'accepted',
    delivered: 'delivered',
    delivery_delayed: 'delayed',
    delayed: 'delayed',
    bounced: 'bounced',
    complained: 'complained',
    failed: 'rejected',
    rejected: 'rejected',
  };
  const mapped = aliases[normalized];
  if (!mapped) throw new Error('email webhook event type is not supported');
  return mapped;
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string') throw new Error('email webhook timestamp is invalid');
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error('email webhook timestamp is invalid');
  return parsed.toISOString();
}

function boundedString(value: unknown, maxLength: number): string {
  if (typeof value !== 'string' || !value || value.length > maxLength) {
    throw new Error('email webhook identifier is invalid');
  }
  return value;
}

function header(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}
