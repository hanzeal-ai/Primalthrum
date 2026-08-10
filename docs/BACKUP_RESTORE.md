# Backup And Restore

## Local SQLite

Primalthrum local-provider backups include:

- `platform.sqlite`: metadata, users, sessions, agents, jobs, runs, documents, provider config references, and audit logs.
- `documents/`: local document files written by `LocalDocumentStorage`.
- `manifest.json`: backup version and included paths.

## Backup

```bash
PRIMALTHRUM_DB_PATH=/var/lib/primalthrum/platform.sqlite \
DOCUMENT_STORAGE_DIR=/var/lib/primalthrum/documents \
scripts/backup.sh /var/backups/primalthrum/latest
```

## Restore

```bash
PRIMALTHRUM_DB_PATH=/var/lib/primalthrum/platform.sqlite \
DOCUMENT_STORAGE_DIR=/var/lib/primalthrum/documents \
scripts/restore.sh /var/backups/primalthrum/latest
```

Stop the server before restoring over an active SQLite database.

## Smoke Test

```bash
scripts/backup-restore-smoke.sh
```

The smoke test creates a temporary SQLite file and document directory, backs both up, mutates them, restores them, and verifies the original values are back.

## S3-Compatible Storage

`scripts/backup.sh` and `scripts/restore.sh` cover the local provider only. For an
S3 production deployment, a recoverable backup set consists of:

- an application database snapshot;
- all object versions and delete markers under the configured bucket prefix;
- the bucket versioning, encryption, lifecycle, replication, and access policy;
- the secret-manager and KMS recovery procedure, without placing secrets in the archive.

Enable versioning and cross-account or cross-region replication before traffic.
Schedule database and object snapshots inside the same documented recovery window,
then record their snapshot identifiers together. The database `storageRef` is the
binding between metadata and an object version path.

Restore in this order:

1. Disable application writes and background retention/account-deletion workers.
2. Restore bucket policy, encryption access, versions, and delete markers to the
   original bucket and prefix.
3. Restore the matching database snapshot.
4. Start one server instance and require `/ready` to report `document_storage=ok`.
5. Test a known document read, RAG index, privacy export, and controlled delete.
6. Re-enable workers and traffic only after the evidence is recorded.

Restoring into a different bucket or prefix requires an explicit reference rewrite
and content-copy migration; changing environment variables alone makes existing
references fail scope validation. Provider-native restore and disaster-recovery
exercises remain deployment release evidence, not a substitute for the local smoke.

## PostgreSQL Logical Backup

Production PostgreSQL requires both provider-managed physical/PITR backups and a
portable logical backup. The logical backup command uses an exported repeatable-read
snapshot so `pg_dump` and the application row fingerprints describe the same database
state. It never places `DATABASE_URL` in child-process arguments or the manifest.

Install PostgreSQL 17 client tools on the operator host and verify `pg_dump` uses the
same major version as the server. Choose a new backup directory; the command refuses
to reuse or overwrite an existing directory. This release stores the application in
the `public` Schema and rejects a different current Schema instead of producing a
partially fingerprinted archive.

From `server/`:

```bash
export DATABASE_URL='postgresql://BACKUP_USER:PASSWORD@HOST:5432/primalthrum?sslmode=verify-full'

pnpm backup:postgres -- \
  --backup-dir /var/backups/primalthrum/2026-08-10T120000Z \
  --managed-backup-ref provider-snapshot-id \
  --object-checkpoint bucket-replication-checkpoint \
  --secret-recovery-ref secret-manager-runbook-version \
  --pitr-restore-point 2026-08-10T12:00:00.000Z
```

The output directory contains:

- `database.pgdump`: custom-format logical archive, mode `0600`;
- `manifest.json`: archive size/SHA-256, PostgreSQL version, all migration IDs,
  exact per-table row counts and canonical SHA-256 digests, plus external recovery
  references. It contains no row values or database credentials.

The database role needs enough read access for every application table and sequence,
`pg_export_snapshot()`, and catalog inspection. Store the whole backup directory in
encrypted, immutable, access-logged storage with a retention policy. The archive
contains encrypted provider/MFA ciphertext and other customer metadata and must still
be treated as sensitive production data.

## PostgreSQL Restore Rehearsal

Restore only into a newly created, dedicated empty database. The restore command uses
the separate `RESTORE_DATABASE_URL` variable and requires explicit confirmation; it
rejects any target containing user relations or routines. It verifies archive size and SHA-256 before
running `pg_restore --single-transaction --exit-on-error`, then recomputes every table
fingerprint before marking the drill successful.

```bash
export RESTORE_DATABASE_URL='postgresql://RESTORE_USER:PASSWORD@HOST:5432/primalthrum_restore?sslmode=verify-full'

pnpm restore:postgres -- \
  --backup-dir /var/backups/primalthrum/2026-08-10T120000Z \
  --report /var/backups/primalthrum/evidence/restore-2026-08-10.json \
  --confirm-empty-target
```

The report path is reserved before the target is changed. A failed empty-target check,
`pg_restore`, or fingerprint comparison leaves `status: "failed"` evidence. Never use a
failed restore target for traffic; discard it and repeat with a new database.

After a successful database restore, restore the matching object-storage checkpoint and
secret/KMS access, then run `/ready`, login, tenant isolation, Agent Run, RAG, billing,
privacy export, Operator audit, and worker smoke tests. Record observed RPO and RTO.

## Managed PITR Gate

The portable commands do not prove the cloud provider's physical backup or point-in-time
recovery service. Commercial launch still requires evidence from the selected provider:

1. automatic backups and continuous WAL retention are enabled with documented RPO;
2. the earliest/latest recoverable timestamps are monitored;
3. a restore to an isolated account/project succeeds at a selected point before and
   after a controlled write;
4. database, object-storage, secret/KMS, payment, email, and metering checkpoints are
   reconciled;
5. the restored stack passes production-like HTTP, worker, and browser acceptance;
6. measured RPO/RTO, snapshot IDs, restore logs, reconciliation report, approvers, and
   rollback decision are retained as release evidence.
