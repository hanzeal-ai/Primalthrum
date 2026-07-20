#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

DB_PATH="$WORK_DIR/platform.sqlite"
DOCUMENT_DIR="$WORK_DIR/documents"
BACKUP_DIR="$WORK_DIR/backup"

mkdir -p "$DOCUMENT_DIR/workspaces/1/agents/1/documents/1"
sqlite3 "$DB_PATH" "CREATE TABLE marker (value TEXT NOT NULL); INSERT INTO marker VALUES ('before');"
printf 'original document\n' > "$DOCUMENT_DIR/workspaces/1/agents/1/documents/1/guide.md"

PRIMALTHRUM_DB_PATH="$DB_PATH" \
DOCUMENT_STORAGE_DIR="$DOCUMENT_DIR" \
  "$ROOT_DIR/scripts/backup.sh" "$BACKUP_DIR" >/dev/null

sqlite3 "$DB_PATH" "UPDATE marker SET value = 'after';"
printf 'mutated document\n' > "$DOCUMENT_DIR/workspaces/1/agents/1/documents/1/guide.md"

PRIMALTHRUM_DB_PATH="$DB_PATH" \
DOCUMENT_STORAGE_DIR="$DOCUMENT_DIR" \
  "$ROOT_DIR/scripts/restore.sh" "$BACKUP_DIR" >/dev/null

test "$(sqlite3 "$DB_PATH" "SELECT value FROM marker;")" = "before"
test "$(cat "$DOCUMENT_DIR/workspaces/1/agents/1/documents/1/guide.md")" = "original document"

echo "backup/restore smoke passed"
