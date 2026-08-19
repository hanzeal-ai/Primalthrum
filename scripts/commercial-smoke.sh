#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PNPM_BIN="${PNPM_BIN:-pnpm}"
AGENT_PYTHON="${AGENT_PYTHON:-$ROOT/agent/.venv/bin/python}"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[commercial-smoke] missing command: $1" >&2
    exit 1
  fi
}

require_command node
require_command sqlite3
require_command "$PNPM_BIN"

if [ ! -x "$AGENT_PYTHON" ]; then
  echo "[commercial-smoke] missing Agent Python: $AGENT_PYTHON" >&2
  exit 1
fi

echo "[commercial-smoke] Agent tests"
(cd "$ROOT/agent" && "$AGENT_PYTHON" -m unittest tests/test_runtime_registry.py tests/test_stream_contract.py)

echo "[commercial-smoke] Server tests, typecheck, build"
(cd "$ROOT/server" && "$PNPM_BIN" test && "$PNPM_BIN" typecheck && "$PNPM_BIN" build)

echo "[commercial-smoke] Web lint and build"
(cd "$ROOT/web" && "$PNPM_BIN" lint && "$PNPM_BIN" build)

echo "[commercial-smoke] Production deployment artifacts"
bash "$ROOT/scripts/production-deployment-smoke.sh"

echo "[commercial-smoke] Demo research agent package"
bash "$ROOT/examples/research-agent/smoke.sh"

echo "[commercial-smoke] Backup and restore"
bash "$ROOT/scripts/backup-restore-smoke.sh"

echo "[commercial-smoke] OK"
