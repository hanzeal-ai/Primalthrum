#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN_ID="$$"
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/primalthrum-production-smoke.XXXXXX")"
COMPOSE_FILE="$ROOT/scripts/fixtures/production-startup-smoke.compose.yml"
export PRODUCTION_SMOKE_PROJECT="primalthrum-production-smoke-${RUN_ID}"
export PRODUCTION_SMOKE_SECRET_DIR="$TEMP_DIR/secrets"
export PRODUCTION_SMOKE_CERT_DIR="$TEMP_DIR/certs"
export PRODUCTION_SMOKE_OTEL_OUTPUT_DIR="$TEMP_DIR/otel-output"
export IMAGE_PREFIX="${IMAGE_PREFIX:-primalthrum}"
export IMAGE_TAG="${IMAGE_TAG:-1.0.0}"
export WEB_BIND_ADDRESS=127.0.0.1
export WEB_PORT="${PRODUCTION_SMOKE_WEB_PORT:-48080}"

COMPOSE=(docker compose -f "$COMPOSE_FILE" --project-name "$PRODUCTION_SMOKE_PROJECT")

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
    echo "[production-startup] missing command: $command" >&2
    exit 1
  fi
done

mkdir -p "$PRODUCTION_SMOKE_SECRET_DIR" "$PRODUCTION_SMOKE_CERT_DIR" \
  "$PRODUCTION_SMOKE_OTEL_OUTPUT_DIR"
chmod 700 "$PRODUCTION_SMOKE_SECRET_DIR"
chmod 755 "$TEMP_DIR" "$PRODUCTION_SMOKE_CERT_DIR"
chmod 777 "$PRODUCTION_SMOKE_OTEL_OUTPUT_DIR"

openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 1 \
  -subj "/CN=minio" \
  -addext "subjectAltName=DNS:minio,DNS:otel,DNS:localhost,IP:127.0.0.1" \
  -keyout "$PRODUCTION_SMOKE_CERT_DIR/private.key" \
  -out "$PRODUCTION_SMOKE_CERT_DIR/public.crt" >/dev/null 2>&1
chmod 644 "$PRODUCTION_SMOKE_CERT_DIR/private.key" "$PRODUCTION_SMOKE_CERT_DIR/public.crt"
cp "$PRODUCTION_SMOKE_CERT_DIR/private.key" "$PRODUCTION_SMOKE_CERT_DIR/server.key"
cp "$PRODUCTION_SMOKE_CERT_DIR/public.crt" "$PRODUCTION_SMOKE_CERT_DIR/server.crt"

write_secret() {
  printf '%s\n' "$2" >"$PRODUCTION_SMOKE_SECRET_DIR/$1"
  chmod 600 "$PRODUCTION_SMOKE_SECRET_DIR/$1"
}

write_secret database_url 'postgresql://primalthrum:primalthrum-smoke@postgres:5432/primalthrum'
write_secret primalthrum_secret_key 'primalthrum-smoke-encryption-key-0123456789abcdef'
write_secret object_storage_access_key_id 'primalthrum-smoke-access'
write_secret object_storage_secret_access_key 'primalthrum-smoke-secret-key'
write_secret stripe_secret_key 'sk_test_primalthrum_smoke'
write_secret stripe_webhook_secret 'whsec_primalthrum_smoke'
write_secret transactional_email_api_key 're_primalthrum_smoke'
write_secret transactional_email_webhook_secret 'email-webhook-primalthrum-smoke'
write_secret abuse_hash_secret 'primalthrum-smoke-abuse-hash-key-0123456789abcdef'
write_secret turnstile_secret_key '1x0000000000000000000000000000000AA'
write_secret operator_bootstrap_token 'primalthrum-smoke-operator-token-0123456789'
write_secret otel_exporter_otlp_headers 'x-primalthrum-smoke=enabled'

export PUBLIC_APP_URL=https://agents.example.test
export OBJECT_STORAGE_ENDPOINT=https://minio:9000
export OBJECT_STORAGE_BUCKET=primalthrum-smoke
export OBJECT_STORAGE_REGION=us-east-1
export OBJECT_STORAGE_PREFIX=production-smoke
export STRIPE_PRICE_PRO=price_smoke_pro
export STRIPE_PRICE_TEAM=price_smoke_team
export STRIPE_PRICE_BUSINESS=price_smoke_business
export STRIPE_PRICE_ENTERPRISE=price_smoke_enterprise
export TRANSACTIONAL_EMAIL_PROVIDER=resend
export TRANSACTIONAL_EMAIL_FROM='Primalthrum <noreply@example.test>'
export TURNSTILE_SITE_KEY=1x00000000000000000000AA
export TURNSTILE_HOSTNAMES=agents.example.test
export TRUSTED_PROXY_HOPS=2
export CLAMAV_HOST=clamav
export CLAMAV_PORT=3310
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://otel:4318/v1/traces
export OTEL_SERVER_SERVICE_NAME=primalthrum-server
export OTEL_WORKER_SERVICE_NAME=primalthrum-worker
export OTEL_DEPLOYMENT_ENVIRONMENT=production-smoke

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  IMAGE_PREFIX="$IMAGE_PREFIX" IMAGE_TAG="$IMAGE_TAG" bash "$ROOT/scripts/production-image-smoke.sh"
fi

"${COMPOSE[@]}" config --quiet
"${COMPOSE[@]}" up --detach --no-build --wait --wait-timeout 240

node -e "
  const assert=require('node:assert/strict');
  const base='http://127.0.0.1:${WEB_PORT}';
  Promise.all([fetch(base+'/healthz'),fetch(base+'/api/public/plans')]).then(async ([health,plans])=>{
    assert.equal(health.status,200);
    assert.equal(plans.status,200);
    const body=await plans.json();
    assert.deepEqual(body.map(plan=>plan.key),['free','pro','team','business','enterprise']);
  }).catch(error=>{console.error(error);process.exit(1)});
"

printf 'Production startup smoke passed: Agent, Server, Worker, and Web healthy\n'
