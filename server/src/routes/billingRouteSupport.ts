import type Koa from 'koa';

import { sendApiError } from '../services/apiErrors';
import { normalizeBillingKey } from '../services/billingValidation';
import { type StructuredLogger } from '../services/logger';
import { PaymentProviderError } from '../services/paymentProvider';

export function requestIdempotencyKey(ctx: Koa.Context): string {
  return normalizeBillingKey(ctx.get('idempotency-key'), 'Idempotency-Key');
}

export function optionalLimit(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('cost limit must be non-negative');
  return parsed;
}

export function optionalBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error('cost control flags must be boolean');
  return value;
}

export function providerUnavailable(ctx: Koa.Context, logger: StructuredLogger): void {
  sendApiError(ctx, logger, {
    status: 503,
    code: 'PAYMENT_PROVIDER_UNAVAILABLE',
    message: 'payment provider is not configured',
  });
}

export function paymentMutationError(
  ctx: Koa.Context,
  logger: StructuredLogger,
  error: unknown,
  invalidCode: 'PAYMENT_CHECKOUT_INVALID' | 'PAYMENT_SUBSCRIPTION_INVALID',
  fallbackMessage: string,
): void {
  sendApiError(ctx, logger, {
    status: error instanceof PaymentProviderError ? error.status : 400,
    code: error instanceof PaymentProviderError ? 'PAYMENT_PROVIDER_FAILED' : invalidCode,
    message: error instanceof Error ? error.message : fallbackMessage,
  });
}
