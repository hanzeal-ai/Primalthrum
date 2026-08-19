# Postgres Persistence Path

Primalthrum uses SQLite for local single-node development and selects PostgreSQL
whenever `DATABASE_URL` is configured. Production startup requires PostgreSQL,
applies ordered migrations before listening, and closes the pool when migration or
application composition fails. Repositories retain synchronous SQLite implementations
for local compatibility while production composition selects their parameterized async
stores.

The next-generation persistence boundary is available in
`server/src/db/asyncAdapter.ts`. `PostgresDatabase` implements this boundary with
the `pg` connection pool, positional parameters, transaction-scoped clients,
rollback, schema introspection, and explicit pool shutdown. Identity, Workspace,
Session, Agent, Agent version, Run, StreamEvent, Document, RAG index, Conversation,
ProviderConfig, Job, CapabilitySettings, ToolAudit, DocumentUploadSecurity,
UsageRating, CreditLedger, UsageExportOutbox, BillingPlan, Entitlement, Trial,
PaymentLifecycle, and ApiKey repositories now use this boundary. The async Billing facade
keeps Plan, Trial, Entitlement, Credits, subscriptions, invoices, refunds, and
Webhook evidence in the same runtime database. Async usage rating and Credits
serialize Workspace mutations in transactions, preserve idempotent immutable evidence,
and enforce cost or balance limits before insertion. Export workers atomically claim rows with
PostgreSQL `SKIP LOCKED`, retain bounded retry evidence, and avoid duplicate
delivery across workers. Application composition selects these repositories
together for runtime metering when an async database is available. Account action
tokens, Workspace onboarding, transactional email Outbox claims, delivery state,
and immutable Provider events also use the parameterized async identity database.
MFA Factors, encrypted Secrets, recovery codes, Challenges, and immutable security
events use that same identity database and transaction boundary.
Workspace ownership transfer now locks both memberships in the async identity
database and commits the role swap with its immutable event atomically.
Abuse rate-limit Buckets, Challenge Grants, and immutable enforcement evidence use
the async runtime database, including atomic cross-instance window increments.
Privacy Consent Receipts and Product Analytics events also use the async runtime
database, with per-subject transaction ordering, shared event idempotency, and
immediate rejection of stale grants after withdrawal.
Workspace Retention policies, immutable enforcement evidence, Tool audit archives,
and durable physical-file deletion queues use the same async runtime database.
Policy enforcement locks each Workspace policy and commits legal-hold checks,
metadata deletion, archive evidence, and the next schedule in one transaction.
Account and Owner-authorized Workspace exports, privacy request transitions,
deletion scheduling, credential revocation, file removal, and account/Workspace
anonymization now use the async runtime database. Deletion locks every active
member Workspace and rechecks legal holds and commercial blockers before files
or metadata are removed.
An asynchronous legal-hold repository now parameterizes placement, listing, and
two-operator release against SQLite or PostgreSQL. PostgreSQL row locks serialize
competing releases and preserve placement/release evidence in the same transaction.
Operator identity and immutable audit now also expose parameterized async repositories;
all Operator route groups await the shared identity/audit contracts. PostgreSQL smoke
verifies one-time bootstrap enforcement, session revocation, password rotation, audit
sanitization, and database-level immutability. Support Access Grants now have an async
repository that locks the Workspace and assignee before enforcing one active grant,
and persists scoped creation and revocation evidence. Customer-account, Agent/Job, and
abuse-event Operator reads now also have parameterized async repositories with explicit
Workspace filters and minimized response contracts. Platform/Workspace overview and
subscription, monthly usage, invoice, refund, and failed-Webhook views now share the same
async boundary without exposing payment URLs, payloads, or error text. Application
Feature Flags now also have an async repository with row-locked revision updates,
one-active-Workspace-override enforcement, deterministic evaluation, and transactional
immutable events. Operator incidents now share that async boundary with row-locked
revision updates, scoped target validation, guarded status transitions, and atomic
append-only timelines. When an async runtime database is configured, application
composition selects it for every Operator identity, audit, support, legal-hold, read,
Feature Flag, and incident store; the SQLite fallback remains available for local mode.
The PostgreSQL Operator application smoke exercises every route group, proves concurrent
incident updates have exactly one winner, and rejects any fallback SQLite access.

`server/worker.ts` now runs the durable document-index, retention, and account-deletion
Job handlers plus account-email and usage-export Outbox delivery without opening an HTTP
port. HTTP replicas use
`BACKGROUND_WORKER_MODE=external`; the Worker polls for cross-process inserts and
gracefully stops after its active Job. Migration `034_job_leases` adds ownership,
expiry, and heartbeat renewal so a new Worker only recovers genuinely expired work.
Surviving Workers also recover expired leases during polling, so takeover does not
depend on another process restart.
Embedded mode remains the default for local single-process development. PostgreSQL
`SKIP LOCKED` and leases make Worker replicas independently scalable without startup
recovery stealing another replica's active Job.
The composition test now creates due retention and privacy work alongside both Outbox
types, proves an external-mode HTTP application neither produces nor consumes any of it,
and verifies that starting the Worker produces, drains, and completes every owned class.
`postgresWorkerFailoverSmoke.ts` runs two production Dispatcher implementations against
PostgreSQL, proves both Workers share a 64-Job load without duplicate execution, abandons
an owned lease to model a process crash, and verifies that the surviving Worker neither
steals the active lease nor requires a restart before recovering it after expiry. The
focused local PostgreSQL 16 run passed with a 32/32 split and one successful second-attempt
takeover. The digest-pinned aggregate smoke still requires a connected environment because
that exact image was not available in the local Docker cache.
`postgresWorkerRollingHandoffSmoke.ts` then models a rolling deployment with an active Job:
the replacement Worker becomes productive before shutdown begins, the old Worker stops
claiming but drains its in-flight Job, and Jobs continue to arrive during that drain. The
focused PostgreSQL 16 run completed all 65 Jobs exactly once; the old Worker completed only
its active Job while the replacement completed the other 64, including 16 created during
shutdown.
`postgresConnectionPoolSmoke.ts` separately saturates the production adapter's two-client
pool with open transactions, verifies that a third acquisition fails at the configured
connection timeout, then releases one client and proves the pool immediately serves new
queries without a restart. The focused PostgreSQL 16 run timed out at 302ms for a 300ms
limit and recovered in 2ms.
The application-level PostgreSQL smoke completes registration and email verification
over HTTP and asserts that no account lifecycle records leak into local SQLite.
`pnpm data:transfer:postgres` now provides maintenance-window SQLite transfer with
schema parity checks, fresh-target enforcement, foreign-key ordering, transactional
copy, Identity sequence repair, and exact row-count/SHA-256 reconciliation. The
production runbook is `docs/SQLITE_TO_POSTGRES_TRANSFER.md`. Production-like transfer,
managed backup, restore, and rollback evidence remain required for launch.

`server/src/db/postgresMigrations.ts` owns a separate PostgreSQL-native migration
chain. It applies immutable ordered IDs in one transaction behind a PostgreSQL
advisory lock, so concurrent server instances cannot race migration application.
Migrations `001` through `009` currently provide core platform metadata,
identity and sessions, encrypted secret references, tool audit, jobs, document
indexing, conversations, and Workspace membership. The remaining SQLite
migration domains are still required before runtime cutover.
Migrations `010` through `014` add Agent version/deployment backfills, Run
idempotency, Workspace capability settings, document upload metadata, and vector
index metadata. Account lifecycle, privacy, email, abuse protection, API-key
security, retention, operator, and legal-hold domains remain required before
runtime cutover.
Migrations `015` through `018` add the commercial plan and entitlement catalog,
Credits ledger, subscriptions, payment lifecycle, immutable rated usage, cost
controls, and durable meter-export Outbox. PostgreSQL trigger functions enforce
credit-account aggregation, nonnegative balances, immutable evidence, historical
Outbox backfill, and automatic enqueue for new rated usage.
Migrations `019` through `025` add account verification and recovery, privacy
consent, transactional email delivery, abuse protection, Workspace API keys,
retention controls, and MFA. Existing account/session timestamps are backfilled,
and all security evidence tables reject updates and deletes at the database layer.
Migrations `026` through `032` complete schema parity for Workspace invitation
email, the Operator control plane and change control, upload security, account
privacy rights, ownership transfer, and legal holds. Migration `033` adds active
Job deduplication for multi-worker scheduling and atomic claims. PostgreSQL-native
schema coverage is now `34/34`; runtime cutover remains blocked by the remaining
asynchronous repository migration and production data-transfer evidence.

## SQLite Assumption Audit

- `server/src/db/sqlite.ts` executes SQL by shelling out to the `sqlite3` CLI and returns JSON rows through `.mode json`.
- `server/src/db/migrations.ts` uses SQLite-friendly DDL: `INTEGER PRIMARY KEY AUTOINCREMENT`, `TEXT`, `CURRENT_TIMESTAMP`, `INSERT OR IGNORE`, and `ON CONFLICT`.
- Repositories build SQL strings with the shared `server/src/db/sql.ts` literal
  helper. This preserves current behavior during boundary extraction, but must be
  replaced by parameterized statements before the PostgreSQL production gate.
- JSON payloads are stored as serialized text columns ending in `_json`; a Postgres implementation can keep `TEXT` first or migrate them to `JSONB` after adapter parity is proven.
- Default single-workspace data uses `DEFAULT_WORKSPACE_ID = 1`; this is compatible with Postgres identity columns as long as bootstrap inserts the local workspace explicitly.

## Compatibility Rules

- Services must import `DatabaseAdapter` and must never import `db/sqlite`.
- Services must not import `db/schema` or perform migration work in constructors.
- Application composition must initialize an injected database before creating
  repositories. Local tests should use `createSqliteDatabase` unless they are
  intentionally testing an uninitialized migration state.
- Keep shared SQL helpers outside concrete adapters.
- Treat synchronous `run(sql)` and `query<T>(sql)` as a temporary compatibility
  boundary, not as a PostgreSQL-ready network contract.
- Keep migrations ordered by immutable IDs in `MIGRATIONS`; never edit an applied migration in place after release.
- New migrations should prefer SQL that can be translated directly to Postgres: explicit table names, explicit foreign keys, text timestamps, and simple default values.
- SQLite-only helper logic such as `PRAGMA table_info` must stay isolated inside
  the concrete SQLite adapter.
- Any Postgres adapter must preserve `schema_migrations` semantics: one row per applied migration ID, idempotent runner execution, and ordered application.

## Deployment Choice

Use SQLite when running one local operator, local demos, or development environments where the server and database share a filesystem.

Use Postgres when running multiple server instances, deploying to managed cloud infrastructure, requiring managed backups, or needing stronger concurrency guarantees for jobs, runs, audit logs, and provider configuration. `NODE_ENV=production` without a valid `DATABASE_URL` is rejected before the server listens.

## Remaining Production Data Gates

1. Execute the transfer tool against the pinned PostgreSQL service in CI and a
   production-like environment, retain the reconciliation report, and reconcile
   document/object transfer.
2. Execute the snapshot-consistent logical backup and empty-target verified restore
   commands in the production-like stack, then prove provider-managed PostgreSQL
   point-in-time recovery and rollback with measured RPO/RTO.
3. Run the full repository, concurrency, migration, HTTP, and browser suites against
   the pinned PostgreSQL service in CI and the production-like deployment stack.
4. Repeat the Worker load/failover, rolling-handoff, and connection-pool exhaustion
   smokes in the digest-pinned CI stack, then complete API/Web zero-downtime traffic
   rollout evidence.

## Integration Smoke

Run the real provider check with Docker:

```bash
scripts/postgres-smoke.sh
```

The script starts an isolated, digest-pinned PostgreSQL 17.10 container and verifies pooled
connectivity, positional parameter binding, commit, rollback, health queries,
concurrent migration locking, migration idempotency, core tables, and identity
sequence behavior. It also executes all 34 migrations and exercises billing
invariants, immutable security evidence, Operator revision guards, invitation
targets, two-operator legal-hold release, atomic Job claims, Capability settings,
and idempotent Tool audit persistence. The same run verifies Account registration,
one-time email verification, Trial activation, and identity-database isolation.
Set `POSTGRES_SMOKE_IMAGE` only when validating another PostgreSQL image explicitly.
