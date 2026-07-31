import Router from '@koa/router';
import type Koa from 'koa';

import { sendApiError } from '../services/apiErrors';
import { BillingError, BillingRepository } from '../services/billingRepository';
import { normalizeBillingKey } from '../services/billingValidation';
import { type StructuredLogger } from '../services/logger';
import { PaymentLifecycleRepository } from '../services/paymentLifecycleRepository';
import { PaymentProviderError, type PaymentProviderAdapter } from '../services/paymentProvider';
import { PaymentError, type PaymentWebhookEvent } from '../services/paymentTypes';
import { PaymentWebhookProcessor } from '../services/paymentWebhookProcessor';
import { verifyStripeWebhookSignature } from '../services/stripeWebhookSignature';
import { type WorkspacePermission } from '../services/workspaceAuthorization';

interface BillingRouteDependencies {
  authorize: (ctx: Koa.Context, permission: WorkspacePermission) => boolean;
  billing: BillingRepository;
  currentUserId: (ctx: Koa.Context) => number;
  currentWorkspaceId: (ctx: Koa.Context) => number;
  logger: StructuredLogger;
  paymentAdapter?: PaymentProviderAdapter;
  payments: PaymentLifecycleRepository;
  publicAppUrl: string;
  stripeWebhookSecret?: string;
  webhooks: PaymentWebhookProcessor;
}

export function registerBillingRoutes(
  router: Router,
  dependencies: BillingRouteDependencies,
): void {
  const {
    authorize,
    billing,
    currentUserId,
    currentWorkspaceId,
    logger,
    paymentAdapter,
    payments,
    publicAppUrl,
    stripeWebhookSecret,
    webhooks,
  } = dependencies;

  router.get('/api/public/plans', (ctx) => {
    ctx.body = billing.listPlans();
  });

  router.post('/api/webhooks/stripe', (ctx) => {
    const rawBody = ctx.request.rawBody ?? '';
    try {
      if (!stripeWebhookSecret) {
        sendApiError(ctx, logger, {
          status: 503,
          code: 'WEBHOOK_NOT_CONFIGURED',
          message: 'Stripe webhook is not configured',
        });
        return;
      }
      const signatureTimestamp = verifyStripeWebhookSignature(
        rawBody,
        ctx.get('stripe-signature'),
        stripeWebhookSecret,
      );
      const event = JSON.parse(rawBody) as PaymentWebhookEvent;
      ctx.body = webhooks.process(event, rawBody, signatureTimestamp);
    } catch (error) {
      const paymentError = error instanceof PaymentError ? error : null;
      const invalidPayload = error instanceof SyntaxError
        || paymentError?.code === 'WEBHOOK_PAYLOAD_INVALID';
      sendApiError(ctx, logger, {
        status: paymentError?.code === 'WEBHOOK_NOT_CONFIGURED' ? 503 : 400,
        code: invalidPayload
          ? 'WEBHOOK_PAYLOAD_INVALID'
          : paymentError?.code?.startsWith('WEBHOOK_SIGNATURE')
            ? 'WEBHOOK_SIGNATURE_INVALID'
            : 'WEBHOOK_PROCESSING_FAILED',
        message: error instanceof Error ? error.message : 'webhook processing failed',
      });
    }
  });

  router.get('/api/billing/summary', (ctx) => {
    if (!authorize(ctx, 'billing.read')) return;
    const workspaceId = currentWorkspaceId(ctx);
    ctx.body = {
      entitlementSnapshot: billing.entitlementSnapshot(workspaceId),
      creditAccount: billing.creditAccount(workspaceId),
      subscription: payments.subscription(workspaceId),
      invoices: payments.listInvoices(workspaceId),
    };
  });

  router.get('/api/billing/invoices', (ctx) => {
    if (!authorize(ctx, 'billing.read')) return;
    ctx.body = payments.listInvoices(currentWorkspaceId(ctx));
  });

  router.post('/api/billing/checkout', async (ctx) => {
    if (!authorize(ctx, 'billing.manage')) return;
    if (!paymentAdapter) return providerUnavailable(ctx, logger);
    try {
      const workspaceId = currentWorkspaceId(ctx);
      const userId = currentUserId(ctx);
      const body = ctx.request.body as { planKey?: unknown };
      const planKey = typeof body.planKey === 'string' ? body.planKey.trim() : '';
      const plan = billing.listPlans().find((candidate) => candidate.key === planKey);
      if (!plan || plan.monthlyPriceMinor <= 0) throw new Error('a paid plan is required');
      const price = payments.priceForPlan(paymentAdapter.name, planKey);
      if (!price) {
        sendApiError(ctx, logger, {
          status: 409,
          code: 'PAYMENT_PRICE_NOT_CONFIGURED',
          message: `payment price for ${planKey} is not configured`,
        });
        return;
      }
      const idempotencyKey = requestIdempotencyKey(ctx);
      const existing = payments.checkoutByKey(workspaceId, paymentAdapter.name, idempotencyKey);
      if (existing) {
        ctx.body = existing;
        return;
      }
      const email = String(ctx.state.authSession?.user.email ?? '');
      let customer = payments.customer(workspaceId, paymentAdapter.name);
      if (!customer) {
        const created = await paymentAdapter.createCustomer({
          workspaceId,
          email,
          idempotencyKey: `${idempotencyKey}:customer`,
        });
        customer = payments.upsertCustomer({
          workspaceId,
          provider: paymentAdapter.name,
          providerCustomerRef: created.id,
          email,
        });
      }
      const session = await paymentAdapter.createCheckoutSession({
        workspaceId,
        planKey,
        priceRef: price.providerPriceRef,
        customerRef: customer.providerCustomerRef,
        successUrl: `${publicAppUrl}/app/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${publicAppUrl}/app/billing?checkout=canceled`,
        idempotencyKey,
      });
      ctx.status = 201;
      ctx.body = payments.recordCheckout({
        workspaceId,
        provider: paymentAdapter.name,
        idempotencyKey,
        providerSessionRef: session.id,
        planKey,
        checkoutUrl: session.url,
        createdByUserId: userId,
        expiresAt: session.expiresAt,
      });
    } catch (error) {
      paymentMutationError(ctx, logger, error, 'PAYMENT_CHECKOUT_INVALID', 'checkout creation failed');
    }
  });

  router.post('/api/billing/portal', async (ctx) => {
    if (!authorize(ctx, 'billing.manage')) return;
    if (!paymentAdapter) return providerUnavailable(ctx, logger);
    try {
      const customer = payments.customer(currentWorkspaceId(ctx), paymentAdapter.name);
      if (!customer) throw new Error('payment customer does not exist');
      ctx.body = await paymentAdapter.createPortalSession({
        customerRef: customer.providerCustomerRef,
        returnUrl: `${publicAppUrl}/app/billing`,
      });
    } catch (error) {
      paymentMutationError(
        ctx,
        logger,
        error,
        'PAYMENT_SUBSCRIPTION_INVALID',
        'billing portal creation failed',
      );
    }
  });

  router.post('/api/billing/subscription/change', async (ctx) => {
    if (!authorize(ctx, 'billing.manage')) return;
    if (!paymentAdapter) return providerUnavailable(ctx, logger);
    try {
      const workspaceId = currentWorkspaceId(ctx);
      const body = ctx.request.body as { planKey?: unknown };
      const planKey = typeof body.planKey === 'string' ? body.planKey.trim() : '';
      const price = payments.priceForPlan(paymentAdapter.name, planKey);
      if (!price) throw new Error('target plan price is not configured');
      const subscription = payments.subscription(workspaceId);
      if (!subscription.providerSubscriptionRef || !subscription.providerSubscriptionItemRef) {
        throw new Error('active provider subscription is required');
      }
      await paymentAdapter.changeSubscription({
        subscriptionRef: subscription.providerSubscriptionRef,
        subscriptionItemRef: subscription.providerSubscriptionItemRef,
        priceRef: price.providerPriceRef,
        idempotencyKey: requestIdempotencyKey(ctx),
      });
      payments.markPendingPlan(workspaceId, planKey);
      ctx.status = 202;
      ctx.body = payments.subscription(workspaceId);
    } catch (error) {
      paymentMutationError(
        ctx,
        logger,
        error,
        'PAYMENT_SUBSCRIPTION_INVALID',
        'subscription change failed',
      );
    }
  });

  router.post('/api/billing/subscription/cancel', async (ctx) => {
    if (!authorize(ctx, 'billing.manage')) return;
    if (!paymentAdapter) return providerUnavailable(ctx, logger);
    try {
      const subscription = payments.subscription(currentWorkspaceId(ctx));
      if (!subscription.providerSubscriptionRef) {
        throw new Error('active provider subscription is required');
      }
      await paymentAdapter.scheduleCancellation({
        subscriptionRef: subscription.providerSubscriptionRef,
        idempotencyKey: requestIdempotencyKey(ctx),
      });
      ctx.status = 202;
      ctx.body = { accepted: true };
    } catch (error) {
      paymentMutationError(
        ctx,
        logger,
        error,
        'PAYMENT_SUBSCRIPTION_INVALID',
        'subscription cancellation failed',
      );
    }
  });

  router.get('/api/billing/entitlements', (ctx) => {
    if (!authorize(ctx, 'billing.read')) return;
    ctx.body = billing.entitlementSnapshot(currentWorkspaceId(ctx));
  });

  router.post('/api/billing/trial', (ctx) => {
    if (!authorize(ctx, 'billing.manage')) return;
    try {
      const body = ctx.request.body as { planKey?: unknown };
      const planKey = typeof body.planKey === 'string' ? body.planKey : 'pro';
      const trial = billing.activateTrial(
        currentWorkspaceId(ctx),
        currentUserId(ctx),
        planKey,
      );
      ctx.status = 201;
      ctx.body = {
        trial,
        entitlementSnapshot: billing.entitlementSnapshot(currentWorkspaceId(ctx)),
        creditAccount: billing.creditAccount(currentWorkspaceId(ctx)),
      };
    } catch (error) {
      const trialErrorCode = error instanceof BillingError
        && (error.code === 'TRIAL_NOT_ELIGIBLE' || error.code === 'TRIAL_PLAN_INVALID')
        ? error.code
        : 'TRIAL_REQUEST_INVALID';
      sendApiError(ctx, logger, {
        status: error instanceof BillingError ? 409 : 400,
        code: trialErrorCode,
        message: error instanceof Error ? error.message : 'trial activation failed',
      });
    }
  });
}

function requestIdempotencyKey(ctx: Koa.Context): string {
  return normalizeBillingKey(ctx.get('idempotency-key'), 'Idempotency-Key');
}

function providerUnavailable(ctx: Koa.Context, logger: StructuredLogger): void {
  sendApiError(ctx, logger, {
    status: 503,
    code: 'PAYMENT_PROVIDER_UNAVAILABLE',
    message: 'payment provider is not configured',
  });
}

function paymentMutationError(
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
