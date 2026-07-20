#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PNPM_BIN="${PNPM_BIN:-pnpm}"
AGENT_PYTHON="${AGENT_PYTHON:-$ROOT/agent/.venv/bin/python}"

if [ ! -x "$AGENT_PYTHON" ]; then
  echo "[smoke] missing Agent Python: $AGENT_PYTHON" >&2
  exit 1
fi

echo "[smoke] Agent tests"
(cd "$ROOT/agent" && "$AGENT_PYTHON" -m unittest tests/test_runtime_registry.py tests/test_stream_contract.py)

echo "[smoke] Server tests"
(cd "$ROOT/server" && "$PNPM_BIN" test && "$PNPM_BIN" typecheck)

echo "[smoke] Web checks"
(cd "$ROOT/web" && "$PNPM_BIN" lint && "$PNPM_BIN" build)

echo "[smoke] OK"
