#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_ID="${$}"
NETWORK="primalthrum-object-smoke-${RUN_ID}"
MINIO_CONTAINER="primalthrum-object-smoke-minio-${RUN_ID}"
PORT="${OBJECT_STORAGE_SMOKE_PORT:-49000}"
ACCESS_KEY="primalthrum-smoke-access"
SECRET_KEY="primalthrum-smoke-secret-key"
BUCKET="primalthrum-smoke"

cleanup() {
  docker rm -f "$MINIO_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker network create "$NETWORK" >/dev/null
docker run --detach --rm \
  --name "$MINIO_CONTAINER" \
  --network "$NETWORK" \
  --publish "127.0.0.1:${PORT}:9000" \
  --env "MINIO_ROOT_USER=${ACCESS_KEY}" \
  --env "MINIO_ROOT_PASSWORD=${SECRET_KEY}" \
  minio/minio:RELEASE.2025-04-22T22-12-26Z server /data >/dev/null

READY=0
for _ in $(seq 1 60); do
  if docker run --rm --network "$NETWORK" minio/mc:RELEASE.2025-04-16T18-13-26Z \
    alias set smoke "http://${MINIO_CONTAINER}:9000" "$ACCESS_KEY" "$SECRET_KEY" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 1
done
test "$READY" -eq 1

docker run --rm --network "$NETWORK" --entrypoint /bin/sh minio/mc:RELEASE.2025-04-16T18-13-26Z \
  -c "mc alias set smoke http://${MINIO_CONTAINER}:9000 '${ACCESS_KEY}' '${SECRET_KEY}' >/dev/null && mc mb --ignore-existing smoke/${BUCKET} >/dev/null && mc version enable smoke/${BUCKET} >/dev/null"

(
  cd "$ROOT_DIR/server"
  DOCUMENT_STORAGE_PROVIDER=s3 \
  OBJECT_STORAGE_ENDPOINT="http://127.0.0.1:${PORT}" \
  OBJECT_STORAGE_ACCESS_KEY_ID="$ACCESS_KEY" \
  OBJECT_STORAGE_SECRET_ACCESS_KEY="$SECRET_KEY" \
  OBJECT_STORAGE_BUCKET="$BUCKET" \
  OBJECT_STORAGE_REGION=us-east-1 \
  OBJECT_STORAGE_PREFIX="smoke-${RUN_ID}" \
  pnpm exec ts-node src/commands/objectStorageSmoke.ts
)

VERSION_COUNT="$(docker run --rm --network "$NETWORK" --entrypoint /bin/sh minio/mc:RELEASE.2025-04-16T18-13-26Z \
  -c "mc alias set smoke http://${MINIO_CONTAINER}:9000 '${ACCESS_KEY}' '${SECRET_KEY}' >/dev/null && mc ls --versions --recursive smoke/${BUCKET}/smoke-${RUN_ID}" | wc -l | tr -d ' ')"
test "$VERSION_COUNT" -ge 2
printf 'object storage versioning smoke passed: %s versions/delete markers\n' "$VERSION_COUNT"
