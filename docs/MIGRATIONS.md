# Database Migrations

Server schema changes are applied through ordered TypeScript migrations in `server/src/db/migrations.ts`.

Run migrations against the default local database:

```bash
cd server
TS_NODE_TRANSPILE_ONLY=1 node --require ts-node/register src/db/migrate.ts
```

Run migrations against a specific SQLite file:

```bash
cd server
TS_NODE_TRANSPILE_ONLY=1 node --require ts-node/register src/db/migrate.ts /absolute/path/platform.sqlite
```

The runner records applied migration IDs in `schema_migrations` and can be run repeatedly.

Migration `015_billing_entitlements_ledger` creates the configurable plan catalog,
subscriptions, one-time trials, entitlement grants, credit reservations, immutable
usage events, immutable ledger entries, and balance projection triggers. Back up
the metadata database before applying it to an existing environment.

Migration `019_account_identity_lifecycle` adds email verification, password
recovery, email delivery evidence, and pending onboarding state. Migration
`020_privacy_consent_analytics` adds immutable privacy receipts and minimized
first-party product analytics events. Migration `021_transactional_email_delivery`
adds Provider delivery identifiers, dead-letter evidence, and immutable signed
delivery event records. Migration `022_abuse_protection` adds atomic rate-limit
buckets, short-lived challenge grants, and immutable HMAC-only enforcement
evidence.
Migration `023_api_keys_security` adds hashed, scoped, expiring Workspace API
Keys, immutable Key-use audit events, and Session last-seen metadata.
Migration `024_workspace_retention` adds customer-configurable retention policy,
immutable policy and enforcement evidence, durable file-deletion intent, and a
preserved tool-audit archive for expired runs.
Migration `025_account_mfa` adds encrypted account-level TOTP factors, hashed
single-use recovery codes, expiring and attempt-bounded login or invitation
challenges, immutable MFA events, and Session authentication assurance metadata.

See [Postgres Persistence Path](POSTGRES_PERSISTENCE.md) before adding migrations that rely on SQLite-only SQL.
