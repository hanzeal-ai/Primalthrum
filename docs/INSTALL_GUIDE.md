# Install Guide

This guide installs Primalthrum for a local or single-node commercial pilot.

## Prerequisites

- Node.js and pnpm.
- Python 3.11 or newer.
- PostgreSQL 17 for production, including matching `pg_dump` and `pg_restore` client
  tools for backup drills; or `sqlite3` on `PATH` for local development.
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

Production HTTP replicas should set `BACKGROUND_WORKER_MODE=external` and run at
least one separate `pnpm worker` process with the same database, Agent runtime,
object-storage, provider, email, and billing configuration. The Worker polls the
PostgreSQL durable Job table, uses atomic `SKIP LOCKED` claims, recovers interrupted
attempts, and finishes an active Job before shutdown. `JOB_POLL_INTERVAL_MS` accepts
values from 25 to 60000 and defaults to 1000. `JOB_LEASE_DURATION_MS` defaults to
five minutes; Workers renew active leases before expiry and only recover expired
leases during periodic polling. Scale Worker replicas independently; the database lease remains the
execution ownership boundary.

Existing SQLite installations must not point the production server at an empty
PostgreSQL database. Follow `docs/SQLITE_TO_POSTGRES_TRANSFER.md` during a
maintenance window, retain its reconciliation report, migrate document objects,
and complete the cutover smoke before reopening traffic.

## Start

```bash
bash start.sh
```

The script starts:

- Web console on port `5173` or the next available port.
- Node server on port `3000` or the next available port.
- Python Agent runtime on port `8000` or the next available port.

For the production-style multi-process topology, `docker compose up` also starts a
dedicated Worker and configures the Node HTTP service for external Worker mode.

## Verify

```bash
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/ready
bash examples/research-agent/smoke.sh
scripts/commercial-smoke.sh
scripts/object-storage-smoke.sh
```
