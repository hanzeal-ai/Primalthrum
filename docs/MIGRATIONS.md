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
Migration `026_workspace_invitation_email` extends the durable transactional
email Outbox with Workspace invitation ownership and delivery context while
preserving all existing account email delivery evidence.
Migration `027_operator_control_plane` adds isolated Operator users and hashed
sessions, explicit time-limited Workspace support grants, and immutable minimized
Operator audit evidence.
Migration `028_operator_change_control` adds audited Feature Flags, one active
Workspace override per Flag and Workspace, deterministic percentage rollout,
immutable Flag history, scoped operational incidents, and immutable incident
timelines. Database guards reject deletion, stale revisions, invalid incident
resolution state, and mutation of historical events.
Migration `029_document_upload_security` adds immutable minimized upload-scan
evidence. It stores tenant/resource/actor IDs, filename and content hashes, MIME,
size, scanner, result, and bounded threat metadata without storing the filename
or document content. Database triggers reject update and deletion.
Migration `030_account_privacy_rights` adds account and Workspace deletion
tombstones, durable export/deletion request state, retry counters, and immutable
hashed data-rights lifecycle events. It preserves billing and security evidence
while allowing customer content and credentials to be erased.
Migration `031_workspace_ownership_transfer` enforces one active Owner per
Workspace and adds immutable ownership-transfer evidence. Existing databases
must resolve any legacy Workspace with multiple active Owners before this
migration can be applied.
Migration `032_workspace_legal_holds` adds restricted Workspace hold cases,
maker-checker release state, and immutable lifecycle evidence. It rebuilds
`retention_events` to allow `enforcement_blocked` while preserving every existing
event ID and payload. Back up the database first and verify active cases and
retention event counts after migration or restore.

See [Postgres Persistence Path](POSTGRES_PERSISTENCE.md) before adding migrations that rely on SQLite-only SQL.
