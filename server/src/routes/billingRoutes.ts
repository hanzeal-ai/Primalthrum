import Router from '@koa/router';
import type Koa from 'koa';

import { sendApiError } from '../services/apiErrors';
import { BillingError } from '../services/billingRepository';
import { type BillingStore } from '../services/billingStore';
import { type StructuredLogger } from '../services/logger';
import { ImmediatePaymentLifecycle } from '../services/immediatePaymentLifecycle';
import { type PaymentLifecycleStore } from '../services/paymentLifecycleStore';
import { type PaymentProviderAdapter } from '../services/paymentProvider';
import { PaymentError, type PaymentWebhookEvent } from '../services/paymentTypes';
import { PaymentWebhookProcessor } from '../services/paymentWebhookProcessor';
import { verifyStripeWebhookSignature } from '../services/stripeWebhookSignature';
import { type WorkspacePermission } from '../services/workspaceAuthorization';
import { type UsageRatingStore } from '../services/usageRatingStore';
import {
  optionalBoolean,
  optionalLimit,
  paymentMutationError,
  providerUnavailable,
  requestIdempotencyKey,
} from './billingRouteSupport';

interface BillingRouteDependencies {
  authorize: (ctx: Koa.Context, permission: WorkspacePermission) => boolean;
  billing: BillingStore;
  currentUserId: (ctx: Koa.Context) => number;
  currentWorkspaceId: (ctx: Koa.Context) => number;
  logger: StructuredLogger;
  paymentAdapter?: PaymentProviderAdapter;
  payments: PaymentLifecycleStore;
  paymentsReady?: Promise<unknown>;
  publicAppUrl: string;
  stripeWebhookSecret?: string;
  webhooks: PaymentWebhookProcessor;
  usage: UsageRatingStore;
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
    usage,
  } = dependencies;
  const paymentsReady = dependencies.paymentsReady ?? Promise.resolve();
  const immediatePayments = paymentAdapter?.checkoutCompletion === 'immediate'
    ? new ImmediatePaymentLifecycle(paymentAdapter.name, payments, billing)
    : null;

  router.get('/api/public/plans', async (ctx) => {
    ctx.body = await billing.listPlans();
  });

  router.post('/api/webhooks/stripe', async (ctx) => {
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
      await paymentsReady;
      ctx.body = await webhooks.process(event, rawBody, signatureTimestamp);
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

  router.get('/api/billing/summary', async (ctx) => {
    if (!authorize(ctx, 'billing.read')) return;
    const workspaceId = currentWorkspaceId(ctx);
    await paymentsReady;
    ctx.body = {
      paymentProvider: paymentAdapter?.name ?? 'disabled',
      entitlementSnapshot: await billing.entitlementSnapshot(workspaceId),
      creditAccount: await billing.creditAccount(workspaceId),
      subscription: await payments.subscription(workspaceId),
      invoices: await payments.listInvoices(workspaceId),
    };
  });

  router.get('/api/billing/invoices', async (ctx) => {
    if (!authorize(ctx, 'billing.read')) return;
    await paymentsReady;
    ctx.body = await payments.listInvoices(currentWorkspaceId(ctx));
  });

  router.get('/api/billing/usage', async (ctx) => {
    if (!authorize(ctx, 'billing.read')) return;
    ctx.body = await usage.summary(currentWorkspaceId(ctx));
  });

  router.get('/api/billing/cost-controls', async (ctx) => {
    if (!authorize(ctx, 'billing.read')) return;
    ctx.body = await usage.controls(currentWorkspaceId(ctx));
  });

  router.put('/api/billing/cost-controls', async (ctx) => {
    if (!authorize(ctx, 'billing.manage')) return;
    try {
      const body = ctx.request.body as Record<string, unknown>;
      const current = await usage.controls(currentWorkspaceId(ctx));
      const creditLimit = optionalLimit(body.monthlyCreditLimit);
      const providerCostLimit = optionalLimit(body.monthlyProviderCostMicrosLimit);
      ctx.body = await usage.setControls({
        workspaceId: currentWorkspaceId(ctx),
        monthlyCreditLimit: creditLimit === undefined ? current.monthlyCreditLimit : creditLimit,
        monthlyProviderCostMicrosLimit: providerCostLimit === undefined
          ? current.monthlyProviderCostMicrosLimit
          : providerCostLimit,
        hardLimit: optionalBoolean(body.hardLimit, current.hardLimit),
        overageEnabled: optionalBoolean(body.overageEnabled, current.overageEnabled),
        alertThresholds: Array.isArray(body.alertThresholds)
          ? body.alertThresholds.map(Number)
          : current.alertThresholds,
        updatedByUserId: currentUserId(ctx),
      });
    } catch (error) {
      sendApiError(ctx, logger, {
        status: 400,
        code: 'USAGE_CONTROL_INVALID',
        message: error instanceof Error ? error.message : 'cost controls are invalid',
      });
    }
  });

  router.get('/api/billing/cost-alerts', async (ctx) => {
    if (!authorize(ctx, 'billing.read')) return;
    ctx.body = await usage.listAlerts(currentWorkspaceId(ctx));
  });

  router.post('/api/billing/checkout', async (ctx) => {
    if (!authorize(ctx, 'billing.manage')) return;
    if (!paymentAdapter) return providerUnavailable(ctx, logger);
    try {
      await paymentsReady;
      const workspaceId = currentWorkspaceId(ctx);
      const userId = currentUserId(ctx);
      const body = ctx.request.body as { planKey?: unknown };
      const planKey = typeof body.planKey === 'string' ? body.planKey.trim() : '';
      const plan = (await billing.listPlans()).find((candidate) => candidate.key === planKey);
      if (!plan || plan.monthlyPriceMinor <= 0) throw new Error('a paid plan is required');
      const price = await payments.priceForPlan(paymentAdapter.name, planKey);
      if (!price) {
        sendApiError(ctx, logger, {
          status: 409,
          code: 'PAYMENT_PRICE_NOT_CONFIGURED',
          message: `payment price for ${planKey} is not configured`,
        });
        return;
      }
      const idempotencyKey = requestIdempotencyKey(ctx);
      const existing = await payments.checkoutByKey(
        workspaceId,
        paymentAdapter.name,
        idempotencyKey,
      );
      if (existing) {
        ctx.body = existing;
        return;
      }
      const email = String(ctx.state.authSession?.user.email ?? '');
      let customer = await payments.customer(workspaceId, paymentAdapter.name);
      if (!customer) {
        const created = await paymentAdapter.createCustomer({
          workspaceId,
          email,
          idempotencyKey: `${idempotencyKey}:customer`,
        });
        customer = await payments.upsertCustomer({
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
      const checkout = await payments.recordCheckout({
        workspaceId,
        provider: paymentAdapter.name,
        idempotencyKey,
        providerSessionRef: session.id,
        planKey,
        checkoutUrl: session.url,
        createdByUserId: userId,
        expiresAt: session.expiresAt,
      });
      if (immediatePayments) {
        await immediatePayments.activatePlan({
          workspaceId,
          plan,
          priceRef: price.providerPriceRef,
          customerRef: customer.providerCustomerRef,
          sessionRef: session.id,
          idempotencyKey,
        });
      }
      ctx.status = 201;
      ctx.body = immediatePayments
        ? await payments.checkoutByKey(workspaceId, paymentAdapter.name, idempotencyKey) ?? checkout
        : checkout;
    } catch (error) {
      paymentMutationError(ctx, logger, error, 'PAYMENT_CHECKOUT_INVALID', 'checkout creation failed');
    }
  });

  router.post('/api/billing/portal', async (ctx) => {
    if (!authorize(ctx, 'billing.manage')) return;
    if (!paymentAdapter) return providerUnavailable(ctx, logger);
    try {
      await paymentsReady;
      const customer = await payments.customer(currentWorkspaceId(ctx), paymentAdapter.name);
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
      await paymentsReady;
      const workspaceId = currentWorkspaceId(ctx);
      const body = ctx.request.body as { planKey?: unknown };
      const planKey = typeof body.planKey === 'string' ? body.planKey.trim() : '';
      const price = await payments.priceForPlan(paymentAdapter.name, planKey);
      if (!price) throw new Error('target plan price is not configured');
      const subscription = await payments.subscription(workspaceId);
      if (!subscription.providerSubscriptionRef || !subscription.providerSubscriptionItemRef) {
        throw new Error('active provider subscription is required');
      }
      await paymentAdapter.changeSubscription({
        subscriptionRef: subscription.providerSubscriptionRef,
        subscriptionItemRef: subscription.providerSubscriptionItemRef,
        priceRef: price.providerPriceRef,
        idempotencyKey: requestIdempotencyKey(ctx),
      });
      if (immediatePayments) {
        const plan = (await billing.listPlans()).find((candidate) => candidate.key === planKey);
        if (!plan) throw new Error('target plan is not configured');
        await immediatePayments.activatePlan({
          workspaceId,
          plan,
          priceRef: price.providerPriceRef,
          customerRef: subscription.providerCustomerRef,
          idempotencyKey: requestIdempotencyKey(ctx),
        });
      } else {
        await payments.markPendingPlan(workspaceId, planKey);
      }
      ctx.status = 202;
      ctx.body = await payments.subscription(workspaceId);
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
      await paymentsReady;
      const subscription = await payments.subscription(currentWorkspaceId(ctx));
      if (!subscription.providerSubscriptionRef) {
        throw new Error('active provider subscription is required');
      }
      await paymentAdapter.scheduleCancellation({
        subscriptionRef: subscription.providerSubscriptionRef,
        idempotencyKey: requestIdempotencyKey(ctx),
      });
      if (immediatePayments) {
        await immediatePayments.cancel(
          currentWorkspaceId(ctx),
          requestIdempotencyKey(ctx),
        );
      }
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

  router.get('/api/billing/entitlements', async (ctx) => {
    if (!authorize(ctx, 'billing.read')) return;
    ctx.body = await billing.entitlementSnapshot(currentWorkspaceId(ctx));
  });

  router.post('/api/billing/trial', async (ctx) => {
    if (!authorize(ctx, 'billing.manage')) return;
    try {
      const body = ctx.request.body as { planKey?: unknown };
      const planKey = typeof body.planKey === 'string' ? body.planKey : 'pro';
      const trial = await billing.activateTrial(
        currentWorkspaceId(ctx),
        currentUserId(ctx),
        planKey,
      );
      ctx.status = 201;
      ctx.body = {
        trial,
        entitlementSnapshot: await billing.entitlementSnapshot(currentWorkspaceId(ctx)),
        creditAccount: await billing.creditAccount(currentWorkspaceId(ctx)),
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
