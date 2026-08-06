# Install Guide

This guide installs Primalthrum for a local or single-node commercial pilot.

## Prerequisites

- Node.js and pnpm.
- Python 3.11 or newer.
- `sqlite3` CLI available on `PATH`.
- A private ClamAV service for every production deployment.

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

Primalthrum writes local metadata, document files, backups, and generated agents outside the source folders by default.

Recommended production-style local paths:

```bash
export DOCUMENT_STORAGE_DIR=/var/lib/primalthrum/documents
export PRIMALTHRUM_BACKUP_DIR=/var/backups/primalthrum
export CLAMAV_HOST=clamav
export CLAMAV_PORT=3310
```

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
```
