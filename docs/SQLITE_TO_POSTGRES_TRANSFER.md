# SQLite To PostgreSQL Transfer

This runbook moves an existing Primalthrum SQLite installation to a dedicated,
freshly migrated PostgreSQL database. The transfer keeps the SQLite source
unchanged and commits the PostgreSQL target only after every application table
has the same row count and SHA-256 row digest.

## Safety Contract

- Schedule a maintenance window and stop every Node server, worker, and operator
  command that can write to the SQLite source.
- Back up the SQLite file and document/object storage before starting.
- Use a new PostgreSQL database dedicated to this Primalthrum environment.
- Use the same application release to prepare the source, run the transfer, and
  start PostgreSQL-backed services.
- Keep the source backup read-only until the cutover observation window closes.
- Migrate document objects separately. This command transfers database metadata,
  not files or S3 objects.

The command fails before copying when the source and target migration IDs,
tables, columns, or primary keys differ. It also rejects target business data.
Only the exact catalog/default-Workspace rows created by the current migrations
are accepted in the target before transfer.

## Prerequisites

1. Verify the stopped SQLite installation has completed all application
   migrations by starting the same release once in local mode, checking
   readiness, and stopping it cleanly.
2. Create a filesystem and object-storage backup as described in
   `docs/BACKUP_RESTORE.md`.
3. Provision PostgreSQL 17 with TLS, restricted credentials, backup retention,
   and enough free capacity for at least twice the source database size.
4. Confirm no application instance is using the target database.
5. Choose a new report path. The command refuses to overwrite an existing report.

## Run

From `server/`:

```bash
export DATABASE_URL='postgresql://USER:PASSWORD@HOST:5432/primalthrum?sslmode=require'

pnpm data:transfer:postgres -- \
  --source ../data/platform.sqlite \
  --report ../data/migration-reports/sqlite-to-postgres.json \
  --batch-size 250 \
  --confirm-maintenance-window
```

Pass `DATABASE_URL` through the deployment secret manager. Do not place it in
shell history, source control, or the reconciliation report.

The command applies current PostgreSQL migrations before inspection. It then:

1. opens a write-blocking SQLite transaction;
2. locks every PostgreSQL application table in one target transaction;
3. verifies the target contains only current migration seed rows;
4. copies tables in foreign-key dependency order with parameterized batches;
5. restores every PostgreSQL Identity sequence;
6. compares ordered canonical rows, row counts, and SHA-256 digests;
7. commits only when every table matches.

Any validation, insert, lock, or reconciliation failure rolls back all target
changes. The report remains with `status: failed` and a sanitized error message.

## Accept The Result

Do not cut over unless all of these are true:

- the command exits with status `0`;
- the report has `status: "succeeded"`;
- the report contains all current migration IDs;
- every table has a row count and 64-character SHA-256 digest;
- `totalRows` equals the sum of table row counts;
- the report is stored with the release evidence and backup identifiers;
- document/object counts and hashes have been reconciled separately.

The report contains schema IDs, counts, and digests only. It does not contain
row values or the database connection string.

## Cut Over

1. Keep the source and target unavailable to user traffic.
2. Configure production `DATABASE_URL` to the verified PostgreSQL database.
3. Start one server instance. Migrations run before the listener opens.
4. Require `/ready` to report the PostgreSQL database check as `ok`.
5. Run registration, login, Workspace isolation, Agent creation, upload, RAG,
   billing, and Operator smoke checks.
6. Start workers and additional server instances only after the single-instance
   checks pass.
7. Record the release, source backup, target backup/PITR position, transfer
   report, and smoke evidence.

## Failure And Rollback

If the transfer command fails, leave the target unused, inspect the failed
report, correct the stated precondition, and rerun against a newly created target
database. Do not manually patch a partially inspected target.

If cutover validation fails before production writes are accepted, stop all
PostgreSQL-backed services and return to the preserved source using the prior
application release. If production writes have already been accepted, do not
switch back to the stale SQLite source. Restore or roll PostgreSQL forward using
the managed backup/PITR procedure and reconcile any external payment, email,
metering, and object-storage side effects before reopening traffic.

## Integration Smoke

`scripts/postgres-smoke.sh` creates a separate PostgreSQL database and runs
`postgresDataTransferSmoke.ts`. The smoke builds a fully migrated SQLite source,
copies representative Workspace, user, and Agent records, reconciles all tables,
checks Identity sequence advancement, and proves a second transfer into the now
non-empty target is rejected.
