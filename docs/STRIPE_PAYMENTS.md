# Stripe Payments And Subscription Lifecycle

Primalthrum uses hosted Stripe Checkout for the first subscription and Stripe's
customer portal for payment-method and invoice self-service. Stripe objects are
payment evidence. Only a verified webhook can update the internal subscription,
entitlements, invoices, refunds, or periodic credit grants.

## Configuration

Copy `server/.env.example` to `server/.env` for direct server startup, or inject
the same variables through the deployment secret manager. Test and live values
must use separate environments and databases.

- `STRIPE_SECRET_KEY`: server-only Stripe API key.
- `STRIPE_WEBHOOK_SECRET`: signing secret for this exact endpoint.
- `STRIPE_API_VERSION`: optional pinned API version managed by the operator.
- `STRIPE_PRICE_*`: recurring Stripe Price IDs mapped to internal plan keys.
- `PUBLIC_APP_URL`: trusted browser origin used to construct Checkout and portal returns.
- `PAYMENT_PROVIDER`: `disabled`, `mock`, or `stripe`. Local development defaults
  to `mock`; a real commercial release must use `stripe`.

Secrets must never use a `VITE_` prefix or be stored in workspace provider
configuration. Missing provider credentials disable payment mutation APIs with a
stable `503` response; the public plan catalog remains available.

Mock mode completes Checkout, plan changes, and cancellation immediately against
the normal subscription, entitlement, and credit repositories. It exists only to
exercise the complete product flow before Stripe credentials are available and
never creates payment evidence or charges a customer.

## Stripe Workbench

Register `POST https://<api-host>/api/webhooks/stripe` and subscribe only to:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`
- `invoice.updated`
- `charge.refunded`
- `refund.created`
- `refund.updated`

The endpoint verifies `Stripe-Signature` against the unmodified UTF-8 request
body with a five-minute tolerance. Event IDs are unique in
`payment_webhook_events`; replay returns success without applying state or credits
again. Provider event time and ID form the state cursor, so late events cannot
regress a newer subscription state.

## Internal Lifecycle

```text
trialing -> active -> cancel_at_period_end -> canceled -> refunded
              |                |
              -> past_due -----+
                    |
                    -> restricted
```

`invoice.paid` activates the plan and grants the configured monthly credits once
per invoice. `invoice.payment_failed` starts a seven-day grace period. An
entitlement read after the grace deadline persists `restricted` and serves free
plan entitlements. A later successful invoice restores paid access. A full
refund records immutable payment evidence; it only changes a subscription to
`refunded` when cancellation was already scheduled or completed.

Plan changes use Stripe pending updates and remain in `pendingPlanKey` until a
subscription or paid invoice webhook confirms the new Price. Cancellation is
scheduled at period end. Browser responses from Checkout, portal, change, and
cancel endpoints never authorize product access by themselves.

## HTTP Surface

- `POST /api/billing/checkout`: Owner or Billing role; requires `Idempotency-Key` and `planKey`.
- `POST /api/billing/portal`: Owner or Billing role; returns a hosted portal URL.
- `POST /api/billing/subscription/change`: Owner or Billing role; requires `Idempotency-Key`.
- `POST /api/billing/subscription/cancel`: Owner or Billing role; requires `Idempotency-Key`.
- `GET /api/billing/invoices`: authorized invoice history.
- `GET /api/billing/summary`: entitlements, credits, canonical subscription, and invoices.

## Sandbox Gate

Before a release, use Stripe test mode and complete this operator gate:

1. Create test recurring Prices and inject every `STRIPE_PRICE_*` value.
2. Forward a Stripe CLI listener to `/api/webhooks/stripe` using that listener's signing secret.
3. Complete Checkout with a Stripe test card and verify `active`, one invoice, and one credit grant.
4. Replay the same event and verify balances do not change.
5. Change plans, renew, fail payment, recover payment, schedule cancellation, and issue a refund.
6. Confirm webhook records contain no secret values and all failed events retain an error for replay.

Automated tests use an HTTP provider contract double and real signed Koa webhook
requests. Live Stripe sandbox execution remains a deployment release gate because
it requires operator-owned test credentials and webhook registration.
