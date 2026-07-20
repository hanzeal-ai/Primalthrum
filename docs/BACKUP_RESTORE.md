# Backup And Restore

Primalthrum local backups include:

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
