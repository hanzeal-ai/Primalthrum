# Billing Entitlements And Credit Ledger

Primalthrum treats internal entitlements and the credit ledger as the product authorization source of truth. Payment provider objects are evidence consumed by the later payment adapter; they never grant access directly.

## Data Model

- `billing_plans` and `plan_entitlements` hold configurable prices, included credits, limits, and feature mappings.
- `workspace_subscriptions` stores the canonical internal subscription state.
- `trial_grants` enforces one trial per user and one trial per workspace.
- `entitlement_grants` adds time-bounded promotional, enterprise, or operator overrides by priority.
- `credit_accounts` materializes available, reserved, and spent balances.
- `credit_reservations` owns the estimate-to-settlement lifecycle.
- `usage_events` and `credit_ledger_entries` are immutable billing evidence.

Credit values are non-negative integer platform credit units. Model and provider pricing converts raw usage into these units in the P18-03 rating layer.

The credit ledger repository supports parameterized asynchronous SQLite and
PostgreSQL access. Grants, reservations, settlements, releases, and refunds are
serialized by Workspace inside database transactions. New Workspaces receive
their Free-plan baseline exactly once, while every later balance mutation remains
an immutable ledger entry applied by the database projection trigger.

The plan catalog and entitlement resolver also support parameterized async
SQLite and PostgreSQL access. Catalog ordering is database-neutral, active plan
and grant precedence are resolved per Workspace, expired trials fall back to
Free, and `past_due` subscriptions become restricted after their grace deadline.

Trial activation has a parameterized async implementation with one transaction
for the grant, credit top-up, and subscription transition. Database uniqueness
enforces one Trial per user and one per Workspace, including concurrent requests.

## Ledger Invariants

1. Every balance change appends one idempotent `credit_ledger_entries` row.
2. A database trigger applies ledger deltas to the materialized credit account.
3. Ledger and usage rows reject update and delete operations.
4. `available + reserved` can only be consumed through an atomic reservation.
5. Settlement charges actual usage, releases an unused estimate, or consumes additional available credit.
6. Failed or canceled work releases its full reservation.
7. Cumulative refunds cannot exceed the original usage charge.
8. Summed ledger deltas must equal the materialized account balances.

## Lifecycle

```text
grant -> reserve -> execute -> settle
                    |       -> refund
                    -> fail/cancel -> release
```

Use a stable idempotency key for each grant, reservation, usage event, and refund. Reusing a key with different values is a conflict.

## HTTP Surface

- `GET /api/public/plans`: public configurable plan catalog.
- `GET /api/billing/summary`: authorized workspace entitlement and credit snapshot.
- `GET /api/billing/entitlements`: authorized workspace entitlement snapshot.
- `POST /api/billing/trial`: Owner or Billing role activation of the one-time Pro trial.

Credit reservation, settlement, release, and refund are server-side repository operations. P18-03 integrates them with runtime metering; they are intentionally not browser-callable mutation endpoints.
