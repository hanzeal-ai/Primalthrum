#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3}"
PNPM_BIN="${PNPM_BIN:-pnpm}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info() { echo -e "${CYAN}[info]${NC} $*"; }
ok() { echo -e "${GREEN}[ok]${NC} $*"; }
warn() { echo -e "${YELLOW}[warn]${NC} $*"; }
die() { echo -e "${RED}[error]${NC} $*" >&2; exit 1; }

command -v "$PYTHON_BIN" >/dev/null 2>&1 || die "Python not found: $PYTHON_BIN"
command -v node >/dev/null 2>&1 || die "Node.js is required"
command -v "$PNPM_BIN" >/dev/null 2>&1 || die "pnpm is required"

is_port_free() {
  "$PYTHON_BIN" - "$1" <<'PY'
import socket
import sys

port = int(sys.argv[1])
targets = [(socket.AF_INET, "127.0.0.1")]
if socket.has_ipv6:
    targets.append((socket.AF_INET6, "::1"))

for family, host in targets:
    sock = socket.socket(family, socket.SOCK_STREAM)
    try:
        sock.bind((host, port))
    except OSError:
        sys.exit(1)
    finally:
        sock.close()
PY
}

choose_port() {
  local port="$1"
  while ! is_port_free "$port"; do
    port=$((port + 1))
  done
  echo "$port"
}

REQUESTED_AGENT_PORT="${AGENT_PORT:-8000}"
REQUESTED_SERVER_PORT="${PORT:-3000}"
REQUESTED_WEB_PORT="${WEB_PORT:-5173}"

AGENT_PORT="$(choose_port "$REQUESTED_AGENT_PORT")"
SERVER_PORT="$(choose_port "$REQUESTED_SERVER_PORT")"
WEB_PORT="$(choose_port "$REQUESTED_WEB_PORT")"

if [ "$AGENT_PORT" != "$REQUESTED_AGENT_PORT" ]; then
  warn "Agent port $REQUESTED_AGENT_PORT is busy; using $AGENT_PORT"
fi
if [ "$SERVER_PORT" != "$REQUESTED_SERVER_PORT" ]; then
  warn "Node port $REQUESTED_SERVER_PORT is busy; using $SERVER_PORT"
fi
if [ "$WEB_PORT" != "$REQUESTED_WEB_PORT" ]; then
  warn "Web port $REQUESTED_WEB_PORT is busy; using $WEB_PORT"
fi

VENV="$ROOT/agent/.venv"
if [ ! -x "$VENV/bin/python" ]; then
  info "Creating Python virtual environment"
  "$PYTHON_BIN" -m venv "$VENV"
fi

info "Installing Agent dependencies"
"$VENV/bin/python" -m pip install -q --upgrade pip
"$VENV/bin/python" -m pip install -q -r "$ROOT/agent/requirements.txt"

for dir in server web; do
  info "Installing $dir dependencies"
  (cd "$ROOT/$dir" && "$PNPM_BIN" install --frozen-lockfile 2>/dev/null || "$PNPM_BIN" install)
done

PIDS=()
cleanup() {
  echo
  info "Stopping services"
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

info "Starting Agent on http://127.0.0.1:$AGENT_PORT"
(cd "$ROOT/agent" && "$VENV/bin/python" -m uvicorn main:app --host 0.0.0.0 --port "$AGENT_PORT" --reload) &
PIDS+=("$!")

for attempt in $(seq 1 20); do
  if curl -sf "http://127.0.0.1:$AGENT_PORT/health" >/dev/null 2>&1; then
    ok "Agent is ready"
    break
  fi
  if [ "$attempt" -eq 20 ]; then
    warn "Agent health check timed out; continuing"
  fi
  sleep 0.5
done

SERVER_AGENT_BASE_URL="${AGENT_BASE_URL:-http://127.0.0.1:$AGENT_PORT}"
info "Starting Node server on http://127.0.0.1:$SERVER_PORT"
(cd "$ROOT/server" && AGENT_BASE_URL="$SERVER_AGENT_BASE_URL" PORT="$SERVER_PORT" "$PNPM_BIN" dev) &
PIDS+=("$!")

for attempt in $(seq 1 20); do
  if curl -sf "http://127.0.0.1:$SERVER_PORT/health" >/dev/null 2>&1; then
    ok "Node server is ready"
    break
  fi
  if [ "$attempt" -eq 20 ]; then
    warn "Node health check timed out; continuing"
  fi
  sleep 0.5
done

info "Starting Web on http://127.0.0.1:$WEB_PORT"
(cd "$ROOT/web" && VITE_SERVER_PROXY_TARGET="http://127.0.0.1:$SERVER_PORT" "$PNPM_BIN" dev --host 0.0.0.0 --port "$WEB_PORT") &
PIDS+=("$!")

echo
ok "Primalthrum is running"
echo "Web:    http://127.0.0.1:$WEB_PORT"
echo "Server: http://127.0.0.1:$SERVER_PORT"
echo "Agent:  http://127.0.0.1:$AGENT_PORT"
echo
echo "Press Ctrl+C to stop all services."

wait
