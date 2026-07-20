# Upgrade Guide

Use this guide before deploying a new Primalthrum version.

## 1. Backup

Create a metadata and document backup before upgrading.

```bash
PRIMALTHRUM_DB_PATH=/var/lib/primalthrum/platform.sqlite \
DOCUMENT_STORAGE_DIR=/var/lib/primalthrum/documents \
scripts/backup.sh /var/backups/primalthrum/pre-upgrade
```

See `docs/BACKUP_RESTORE.md` for restore commands.

## 2. Stop Services

Stop the web, server, and agent processes. Ensure no indexing jobs or active stream runs are in progress.

## 3. Install Dependencies

```bash
cd agent && ./.venv/bin/pip install -r requirements.txt
cd ../server && pnpm install
cd ../web && pnpm install
```

## 4. Run Migrations

```bash
cd server
TS_NODE_TRANSPILE_ONLY=1 node --require ts-node/register src/db/migrate.ts /var/lib/primalthrum/platform.sqlite
```

Migrations are ordered and idempotent. See `docs/MIGRATIONS.md`.

## 5. Verify

```bash
cd server && pnpm test && pnpm typecheck
cd ../web && pnpm lint && pnpm build
cd ../agent && ./.venv/bin/python -m unittest tests/test_runtime_registry.py tests/test_stream_contract.py
```

## 6. Restart

Start services and verify:

```bash
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/ready
```
