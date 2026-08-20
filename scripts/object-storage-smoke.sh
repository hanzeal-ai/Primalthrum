#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_ID="${$}"
NETWORK="primalthrum-object-smoke-${RUN_ID}"
MINIO_CONTAINER="primalthrum-object-smoke-minio-${RUN_ID}"
PORT="${OBJECT_STORAGE_SMOKE_PORT:-49000}"
MINIO_IMAGE="${MINIO_IMAGE:-minio/minio:RELEASE.2025-04-22T22-12-26Z}"
ACCESS_KEY="primalthrum-smoke-access"
SECRET_KEY="primalthrum-smoke-secret-key"
BUCKET="primalthrum-smoke"

if ! command -v openssl >/dev/null 2>&1; then
  echo "object storage smoke requires openssl" >&2
  exit 1
fi
CERT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/primalthrum-object-certs.XXXXXX")"

cleanup() {
  docker rm -f "$MINIO_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  rm -rf "$CERT_DIR"
}
trap cleanup EXIT

openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -keyout "$CERT_DIR/private.key" \
  -out "$CERT_DIR/public.crt" \
  -subj "/CN=${MINIO_CONTAINER}" \
  -addext "subjectAltName=DNS:${MINIO_CONTAINER},IP:127.0.0.1" >/dev/null 2>&1

docker network create "$NETWORK" >/dev/null
docker run --detach --rm \
  --name "$MINIO_CONTAINER" \
  --network "$NETWORK" \
  --publish "127.0.0.1:${PORT}:9000" \
  --env "MINIO_ROOT_USER=${ACCESS_KEY}" \
  --env "MINIO_ROOT_PASSWORD=${SECRET_KEY}" \
  --volume "$CERT_DIR:/root/.minio/certs:ro" \
  "$MINIO_IMAGE" server /data >/dev/null

READY=0
for _ in $(seq 1 60); do
  if docker exec "$MINIO_CONTAINER" mc alias set --insecure smoke \
    "https://127.0.0.1:9000" "$ACCESS_KEY" "$SECRET_KEY" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 1
done
test "$READY" -eq 1

docker exec "$MINIO_CONTAINER" sh -c \
  "mc alias set --insecure smoke https://127.0.0.1:9000 '${ACCESS_KEY}' '${SECRET_KEY}' >/dev/null && mc mb --insecure --ignore-existing smoke/${BUCKET} >/dev/null && mc version enable --insecure smoke/${BUCKET} >/dev/null"

(
  cd "$ROOT_DIR/server"
  NODE_ENV=production \
  NODE_EXTRA_CA_CERTS="$CERT_DIR/public.crt" \
  DOCUMENT_STORAGE_PROVIDER=s3 \
  OBJECT_STORAGE_ENDPOINT="https://127.0.0.1:${PORT}" \
  OBJECT_STORAGE_ACCESS_KEY_ID="$ACCESS_KEY" \
  OBJECT_STORAGE_SECRET_ACCESS_KEY="$SECRET_KEY" \
  OBJECT_STORAGE_BUCKET="$BUCKET" \
  OBJECT_STORAGE_REGION=us-east-1 \
  OBJECT_STORAGE_PREFIX="smoke-${RUN_ID}" \
  pnpm exec ts-node src/commands/objectStorageSmoke.ts
)

VERSION_COUNT="$(docker exec "$MINIO_CONTAINER" sh -c \
  "mc alias set --insecure smoke https://127.0.0.1:9000 '${ACCESS_KEY}' '${SECRET_KEY}' >/dev/null && mc ls --insecure --versions --recursive smoke/${BUCKET}/smoke-${RUN_ID}" | wc -l | tr -d ' ')"
test "$VERSION_COUNT" -ge 2
printf 'object storage versioning smoke passed: %s versions/delete markers\n' "$VERSION_COUNT"
