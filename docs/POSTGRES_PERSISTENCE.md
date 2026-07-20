# Postgres Persistence Path

Primalthrum currently ships with SQLite for a single-node local deployment. The server DB layer is now prepared around a minimal `DatabaseAdapter` contract so a Postgres adapter can replace `SqliteDatabase` without changing repositories.

## SQLite Assumption Audit

- `server/src/db/sqlite.ts` executes SQL by shelling out to the `sqlite3` CLI and returns JSON rows through `.mode json`.
- `server/src/db/migrations.ts` uses SQLite-friendly DDL: `INTEGER PRIMARY KEY AUTOINCREMENT`, `TEXT`, `CURRENT_TIMESTAMP`, `INSERT OR IGNORE`, `ON CONFLICT`, and `PRAGMA table_info`.
- Repositories currently build SQL strings with `sqlValue`; this is acceptable for the local SQLite provider but should be replaced by parameterized execution in a Postgres adapter.
- JSON payloads are stored as serialized text columns ending in `_json`; a Postgres implementation can keep `TEXT` first or migrate them to `JSONB` after adapter parity is proven.
- Default single-workspace data uses `DEFAULT_WORKSPACE_ID = 1`; this is compatible with Postgres identity columns as long as bootstrap inserts the local workspace explicitly.

## Compatibility Rules

- Keep repositories dependent on `run(sql)` and `query<T>(sql)` until a parameterized adapter lands.
- Keep migrations ordered by immutable IDs in `MIGRATIONS`; never edit an applied migration in place after release.
- New migrations should prefer SQL that can be translated directly to Postgres: explicit table names, explicit foreign keys, text timestamps, and simple default values.
- SQLite-only helper logic such as `PRAGMA table_info` must stay isolated inside DB migration helpers.
- Any Postgres adapter must preserve `schema_migrations` semantics: one row per applied migration ID, idempotent runner execution, and ordered application.

## Deployment Choice

Use SQLite when running one local operator, local demos, or development environments where the server and database share a filesystem.

Use Postgres when running multiple server instances, deploying to managed cloud infrastructure, requiring managed backups, or needing stronger concurrency guarantees for jobs, runs, audit logs, and provider configuration.

## Postgres Adapter Plan

1. Add `PostgresDatabase` implementing `DatabaseAdapter` with parameterized `run` and `query`.
2. Add a Postgres SQL dialect for migration helpers that maps SQLite-specific DDL to Postgres DDL.
3. Run the existing server test suite against both adapters in CI.
4. Add deployment documentation for `DATABASE_URL`, backups, and migration execution.
