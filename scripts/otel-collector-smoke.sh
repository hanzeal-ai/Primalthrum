#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN_ID="$$"
CONTAINER="primalthrum-otel-smoke-${RUN_ID}"
PORT="${OTEL_SMOKE_PORT:-44318}"
IMAGE="${OTEL_COLLECTOR_IMAGE:-otel/opentelemetry-collector-contrib@sha256:f2f01157055a9b2aab9df7118e1f1c9abf345e99b23bc7a2bc791db374a7d0f6}"
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/primalthrum-otel-smoke.XXXXXX")"
CERT_DIR="$TEMP_DIR/certs"
OUTPUT_DIR="$TEMP_DIR/output"
TRACE_OUTPUT="$OUTPUT_DIR/traces.json"

cleanup() {
  docker rm --force "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

for command in docker node openssl; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "[otel-collector] missing command: $command" >&2
    exit 1
  fi
done

mkdir -p "$CERT_DIR" "$OUTPUT_DIR"
chmod 755 "$TEMP_DIR" "$CERT_DIR"
chmod 777 "$OUTPUT_DIR"
openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 1 \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
  -keyout "$CERT_DIR/server.key" \
  -out "$CERT_DIR/server.crt" >/dev/null 2>&1
chmod 644 "$CERT_DIR/server.key" "$CERT_DIR/server.crt"

docker run --detach --rm \
  --name "$CONTAINER" \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --publish "127.0.0.1:${PORT}:4318" \
  --volume "$ROOT/scripts/fixtures/otel-collector-smoke.yaml:/etc/otelcol-contrib/config.yaml:ro" \
  --volume "$CERT_DIR:/certs:ro" \
  --volume "$OUTPUT_DIR:/output" \
  "$IMAGE" >/dev/null

READY=0
for _ in $(seq 1 120); do
  if NODE_EXTRA_CA_CERTS="$CERT_DIR/server.crt" node -e "
    const tls=require('node:tls');
    const socket=tls.connect({host:'127.0.0.1',port:${PORT},servername:'localhost'});
    const timer=setTimeout(()=>process.exit(1),1000);
    socket.on('secureConnect',()=>{clearTimeout(timer);socket.destroy();process.exit(0)});
    socket.on('error',()=>process.exit(1));
  " >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 1
done
if [[ "$READY" != "1" ]]; then
  docker logs "$CONTAINER" >&2 || true
  exit 1
fi

(
  cd "$ROOT/server"
  NODE_EXTRA_CA_CERTS="$CERT_DIR/server.crt" \
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="https://127.0.0.1:${PORT}/v1/traces" \
  node node_modules/ts-node/dist/bin.js src/commands/otelCollectorSmoke.ts
)

VERIFIED=0
for _ in $(seq 1 50); do
  if [[ -s "$TRACE_OUTPUT" ]] && node "$ROOT/scripts/verify-otel-collector-output.mjs" "$TRACE_OUTPUT"; then
    VERIFIED=1
    break
  fi
  sleep 0.1
done
if [[ "$VERIFIED" != "1" ]]; then
  docker logs "$CONTAINER" >&2 || true
  exit 1
fi
