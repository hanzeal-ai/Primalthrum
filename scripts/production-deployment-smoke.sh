#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PNPM_BIN="${PNPM_BIN:-pnpm}"

if ! command -v docker >/dev/null 2>&1; then
  echo "[production-deployment] missing command: docker" >&2
  exit 1
fi
if ! command -v "$PNPM_BIN" >/dev/null 2>&1; then
  echo "[production-deployment] missing command: $PNPM_BIN" >&2
  exit 1
fi

echo "[production-deployment] Compose topology"
node "$ROOT/scripts/verify-production-compose.mjs"

echo "[production-deployment] Web static server and API proxy"
(cd "$ROOT/web" && "$PNPM_BIN" test:production-server)

echo "[production-deployment] OK"
