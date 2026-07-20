#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: scripts/backup.sh /path/to/backup-dir" >&2
  exit 2
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR/server"
TS_NODE_TRANSPILE_ONLY=1 node --require ts-node/register src/commands/backup.ts "$1"
