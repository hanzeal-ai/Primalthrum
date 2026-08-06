# Backup And Restore

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
