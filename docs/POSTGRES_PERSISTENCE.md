# Postgres Persistence Path

Primalthrum currently ships with SQLite for a single-node local deployment.
Repositories now depend on `DatabaseAdapter` instead of the concrete
`SqliteDatabase`, schema introspection is owned by the adapter, and repository
constructors no longer execute migrations. Database initialization now happens
once at the application composition boundary. The Agent runtime path is being
migrated incrementally, while commercial, security, compliance, and Operator
repositories still contain synchronous SQLite-specific operations.

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
The application-level PostgreSQL smoke completes registration and email verification
over HTTP and asserts that no account lifecycle records leak into local SQLite. PostgreSQL
must not be selected as the sole application database until the remaining
repositories and production data-transfer gates are complete.

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
schema coverage is now `33/33`; runtime cutover remains blocked by the remaining
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

Use Postgres when running multiple server instances, deploying to managed cloud infrastructure, requiring managed backups, or needing stronger concurrency guarantees for jobs, runs, audit logs, and provider configuration.

## Postgres Adapter Plan

1. Convert the database contract and repository methods to asynchronous,
   parameterized operations while retaining the SQLite test provider.
2. Isolate transaction modes, identity retrieval, JSON access, and DDL behind
   explicit dialect operations.
3. Add a pooled PostgreSQL adapter and a PostgreSQL-native ordered migration set.
4. Run repository, concurrency, migration, and full HTTP suites against a real
   pinned PostgreSQL container in CI.
5. Add SQLite-to-PostgreSQL migration, reconciliation, backup, restore, rollback,
   and deployment evidence before selecting PostgreSQL in production.

## Integration Smoke

Run the real provider check with Docker:

```bash
scripts/postgres-smoke.sh
```

The script starts an isolated, digest-pinned PostgreSQL 17.10 container and verifies pooled
connectivity, positional parameter binding, commit, rollback, health queries,
concurrent migration locking, migration idempotency, core tables, and identity
sequence behavior. It also executes all 33 migrations and exercises billing
invariants, immutable security evidence, Operator revision guards, invitation
targets, two-operator legal-hold release, atomic Job claims, Capability settings,
and idempotent Tool audit persistence. The same run verifies Account registration,
one-time email verification, Trial activation, and identity-database isolation.
Set `POSTGRES_SMOKE_IMAGE` only when validating another PostgreSQL image explicitly.
