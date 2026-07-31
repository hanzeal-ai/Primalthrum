import { createHmac, timingSafeEqual } from 'node:crypto';

import { PaymentError } from './paymentTypes';

const DEFAULT_TOLERANCE_SECONDS = 300;

export function verifyStripeWebhookSignature(
  rawBody: string,
  signatureHeader: string,
  endpointSecret: string,
  now: () => Date = () => new Date(),
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
): number {
  if (!rawBody) throw new PaymentError('WEBHOOK_PAYLOAD_INVALID', 'webhook body is required');
  if (!endpointSecret.trim()) {
    throw new PaymentError('WEBHOOK_NOT_CONFIGURED', 'webhook endpoint secret is not configured');
  }
  const parts = signatureHeader.split(',').map((part) => part.trim());
  const timestamp = Number(parts.find((part) => part.startsWith('t='))?.slice(2));
  const signatures = parts
    .filter((part) => part.startsWith('v1='))
    .map((part) => part.slice(3))
    .filter(Boolean);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || signatures.length === 0) {
    throw new PaymentError('WEBHOOK_SIGNATURE_INVALID', 'Stripe-Signature header is invalid');
  }
  const age = Math.abs(Math.floor(now().getTime() / 1000) - timestamp);
  if (age > toleranceSeconds) {
    throw new PaymentError('WEBHOOK_SIGNATURE_EXPIRED', 'webhook signature timestamp is outside tolerance');
  }
  const expected = createHmac('sha256', endpointSecret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest();
  const valid = signatures.some((signature) => {
    if (!/^[a-f0-9]{64}$/i.test(signature)) return false;
    const candidate = Buffer.from(signature, 'hex');
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  });
  if (!valid) throw new PaymentError('WEBHOOK_SIGNATURE_INVALID', 'webhook signature is invalid');
  return timestamp;
}
