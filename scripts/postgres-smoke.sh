#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_ID="${$}"
CONTAINER="primalthrum-postgres-smoke-${RUN_ID}"
PASSWORD="primalthrum-smoke-password"
DATABASE="primalthrum_smoke"
IMAGE="${POSTGRES_SMOKE_IMAGE:-postgres@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193}"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run --detach --rm \
  --name "$CONTAINER" \
  --publish "127.0.0.1::5432" \
  --env "POSTGRES_PASSWORD=${PASSWORD}" \
  --env "POSTGRES_DB=${DATABASE}" \
  "$IMAGE" >/dev/null

READY=0
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready --username postgres --dbname "$DATABASE" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 1
done
test "$READY" -eq 1

PORT="$(docker port "$CONTAINER" 5432/tcp | sed 's/.*://')"
test -n "$PORT"

(
  cd "$ROOT_DIR/server"
  DATABASE_URL="postgresql://postgres:${PASSWORD}@127.0.0.1:${PORT}/${DATABASE}" \
    pnpm exec ts-node src/commands/postgresSmoke.ts
  DATABASE_URL="postgresql://postgres:${PASSWORD}@127.0.0.1:${PORT}/${DATABASE}" \
    pnpm exec ts-node src/commands/postgresMigrationSmoke.ts
  DATABASE_URL="postgresql://postgres:${PASSWORD}@127.0.0.1:${PORT}/${DATABASE}" \
    pnpm exec ts-node src/commands/postgresIdentityRepositorySmoke.ts
  DATABASE_URL="postgresql://postgres:${PASSWORD}@127.0.0.1:${PORT}/${DATABASE}" \
    pnpm exec ts-node src/commands/postgresWorkspaceRepositorySmoke.ts
  DATABASE_URL="postgresql://postgres:${PASSWORD}@127.0.0.1:${PORT}/${DATABASE}" \
    pnpm exec ts-node src/commands/postgresAgentRuntimeRepositorySmoke.ts
  DATABASE_URL="postgresql://postgres:${PASSWORD}@127.0.0.1:${PORT}/${DATABASE}" \
    pnpm exec ts-node src/commands/postgresAgentVersionRepositorySmoke.ts
  DATABASE_URL="postgresql://postgres:${PASSWORD}@127.0.0.1:${PORT}/${DATABASE}" \
    pnpm exec ts-node src/commands/postgresDocumentIndexRepositorySmoke.ts
  DATABASE_URL="postgresql://postgres:${PASSWORD}@127.0.0.1:${PORT}/${DATABASE}" \
    pnpm exec ts-node src/commands/postgresConversationRepositorySmoke.ts
  DATABASE_URL="postgresql://postgres:${PASSWORD}@127.0.0.1:${PORT}/${DATABASE}" \
    pnpm exec ts-node src/commands/postgresJobRepositorySmoke.ts
  DATABASE_URL="postgresql://postgres:${PASSWORD}@127.0.0.1:${PORT}/${DATABASE}" \
    pnpm exec ts-node src/commands/postgresRuntimeControlsRepositorySmoke.ts
  DATABASE_URL="postgresql://postgres:${PASSWORD}@127.0.0.1:${PORT}/${DATABASE}" \
    pnpm exec ts-node src/commands/postgresUploadSecurityRepositorySmoke.ts
  DATABASE_URL="postgresql://postgres:${PASSWORD}@127.0.0.1:${PORT}/${DATABASE}" \
    pnpm exec ts-node src/commands/postgresUsageRatingRepositorySmoke.ts
  DATABASE_URL="postgresql://postgres:${PASSWORD}@127.0.0.1:${PORT}/${DATABASE}" \
    pnpm exec ts-node src/commands/postgresCreditLedgerRepositorySmoke.ts
  DATABASE_URL="postgresql://postgres:${PASSWORD}@127.0.0.1:${PORT}/${DATABASE}" \
    pnpm exec ts-node src/commands/postgresUsageExportOutboxRepositorySmoke.ts
  DATABASE_URL="postgresql://postgres:${PASSWORD}@127.0.0.1:${PORT}/${DATABASE}" \
    pnpm exec ts-node src/commands/postgresCommercialAuthorizationRepositoriesSmoke.ts
  DATABASE_URL="postgresql://postgres:${PASSWORD}@127.0.0.1:${PORT}/${DATABASE}" \
    pnpm exec ts-node src/commands/postgresTrialRepositorySmoke.ts
  DATABASE_URL="postgresql://postgres:${PASSWORD}@127.0.0.1:${PORT}/${DATABASE}" \
    pnpm exec ts-node src/commands/postgresPaymentLifecycleRepositorySmoke.ts
  DATABASE_URL="postgresql://postgres:${PASSWORD}@127.0.0.1:${PORT}/${DATABASE}" \
    pnpm exec ts-node src/commands/postgresBillingAppSmoke.ts
  DATABASE_URL="postgresql://postgres:${PASSWORD}@127.0.0.1:${PORT}/${DATABASE}" \
    pnpm exec ts-node src/commands/postgresApiKeyAppSmoke.ts
  DATABASE_URL="postgresql://postgres:${PASSWORD}@127.0.0.1:${PORT}/${DATABASE}" \
    pnpm exec ts-node src/commands/postgresAccountLifecycleAppSmoke.ts
  DATABASE_URL="postgresql://postgres:${PASSWORD}@127.0.0.1:${PORT}/${DATABASE}" \
    pnpm exec ts-node src/commands/postgresProviderConfigRepositorySmoke.ts
)
