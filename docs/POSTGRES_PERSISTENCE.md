# Postgres Persistence Path

Primalthrum currently ships with SQLite for a single-node local deployment.
Repositories now depend on `DatabaseAdapter` instead of the concrete
`SqliteDatabase`, and schema introspection is owned by the adapter. This removes
the concrete storage dependency, but it does not yet make the runtime PostgreSQL
compatible: repository operations are synchronous and much of the SQL is still
SQLite-specific.

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
