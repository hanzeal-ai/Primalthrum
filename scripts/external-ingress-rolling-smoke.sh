#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN_ID="$$"
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/primalthrum-ingress-smoke.XXXXXX")"
COMPOSE_FILE="$ROOT/scripts/fixtures/external-ingress-rolling.compose.yml"
export ROLLING_SMOKE_PROJECT="primalthrum-ingress-smoke-${RUN_ID}"
export ROLLING_SMOKE_CONFIG_DIR="$TEMP_DIR/config"
export ROLLING_SMOKE_CERT_DIR="$TEMP_DIR/certs"
export ROLLING_SMOKE_PORT="${ROLLING_SMOKE_PORT:-48443}"
export IMAGE_PREFIX="${IMAGE_PREFIX:-primalthrum}"
export IMAGE_TAG="${IMAGE_TAG:-1.0.0}"
READY_FILE="$TEMP_DIR/stream-ready"
COMPOSE=(docker compose -f "$COMPOSE_FILE" --project-name "$ROLLING_SMOKE_PROJECT")

cleanup() {
  local status=$?
  if [[ "$status" != "0" ]]; then
    "${COMPOSE[@]}" logs --no-color >&2 || true
  fi
  "${COMPOSE[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

for command in docker node openssl; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "[external-ingress] missing command: $command" >&2
    exit 1
  fi
done

mkdir -p "$ROLLING_SMOKE_CONFIG_DIR" "$ROLLING_SMOKE_CERT_DIR"
chmod 755 "$TEMP_DIR" "$ROLLING_SMOKE_CONFIG_DIR" "$ROLLING_SMOKE_CERT_DIR"
cp "$ROOT/scripts/fixtures/nginx-rolling.conf" "$ROLLING_SMOKE_CONFIG_DIR/nginx.conf"
cp "$ROOT/scripts/fixtures/nginx-upstream-old.conf" "$ROLLING_SMOKE_CONFIG_DIR/upstream.conf"
openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 1 \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
  -keyout "$ROLLING_SMOKE_CERT_DIR/private.key" \
  -out "$ROLLING_SMOKE_CERT_DIR/public.crt" >/dev/null 2>&1
chmod 644 "$ROLLING_SMOKE_CERT_DIR/private.key" "$ROLLING_SMOKE_CERT_DIR/public.crt"

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  IMAGE_PREFIX="$IMAGE_PREFIX" IMAGE_TAG="$IMAGE_TAG" bash "$ROOT/scripts/production-image-smoke.sh"
fi

"${COMPOSE[@]}" config --quiet
"${COMPOSE[@]}" up --detach --no-build --wait --wait-timeout 90

NODE_EXTRA_CA_CERTS="$ROLLING_SMOKE_CERT_DIR/public.crt" \
  node "$ROOT/scripts/fixtures/rolling-stream-client.mjs" \
  "https://127.0.0.1:${ROLLING_SMOKE_PORT}/api/stream" "$READY_FILE" &
STREAM_PID=$!

for _ in $(seq 1 100); do
  [[ -f "$READY_FILE" ]] && break
  sleep 0.1
done
[[ -f "$READY_FILE" ]]

cp "$ROOT/scripts/fixtures/nginx-upstream-new.conf" "$ROLLING_SMOKE_CONFIG_DIR/upstream.conf"
INGRESS_ID="$("${COMPOSE[@]}" ps --quiet ingress)"
docker exec "$INGRESS_ID" nginx -s reload -c /config/nginx.conf

ROUTED=0
for _ in $(seq 1 50); do
  if NODE_EXTRA_CA_CERTS="$ROLLING_SMOKE_CERT_DIR/public.crt" node -e "
    fetch('https://127.0.0.1:${ROLLING_SMOKE_PORT}/api/instance')
      .then(async response=>process.exit(response.ok && await response.text()==='new'?0:1))
      .catch(()=>process.exit(1));
  "; then
    ROUTED=1
    break
  fi
  sleep 0.1
done
[[ "$ROUTED" == "1" ]]

"${COMPOSE[@]}" stop --timeout 15 web-old
wait "$STREAM_PID"

printf 'External ingress rolling smoke passed: new traffic switched and old stream drained\n'
