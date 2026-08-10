# Install Guide

This guide installs Primalthrum for a local or single-node commercial pilot.

## Prerequisites

- Node.js and pnpm.
- Python 3.11 or newer.
- PostgreSQL 17 for production, or `sqlite3` on `PATH` for local development.
- A private ClamAV service for every production deployment.
- A private, versioned S3-compatible bucket for production document storage.
- Docker when running the object-storage integration smoke locally.

## Install Dependencies

```bash
cd agent
python -m venv .venv
./.venv/bin/pip install -r requirements.txt

cd ../server
pnpm install

cd ../web
pnpm install
```

## Runtime Directories

Primalthrum writes local metadata, backups, and generated agents outside the
source folders by default. Local development may also write document files there;
production requires the S3-compatible provider described in `docs/FILE_STORAGE.md`.

Recommended production-style local paths:

```bash
export DOCUMENT_STORAGE_DIR=/var/lib/primalthrum/documents
export PRIMALTHRUM_BACKUP_DIR=/var/backups/primalthrum
export CLAMAV_HOST=clamav
export CLAMAV_PORT=3310
```

For a production server, configure `DATABASE_URL`, `DOCUMENT_STORAGE_PROVIDER=s3`,
and every `OBJECT_STORAGE_*` value from `server/.env.example` through the deployment
secret manager. The Node server validates the PostgreSQL URL, opens a bounded pool,
applies all ordered migrations, and only then opens its HTTP port. Startup fails closed
without PostgreSQL, when migration fails, when production uses local storage, or when
the object-storage endpoint is HTTP.

## Start

```bash
bash start.sh
```

The script starts:

- Web console on port `5173` or the next available port.
- Node server on port `3000` or the next available port.
- Python Agent runtime on port `8000` or the next available port.

## Verify

```bash
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/ready
bash examples/research-agent/smoke.sh
scripts/commercial-smoke.sh
scripts/object-storage-smoke.sh
```
