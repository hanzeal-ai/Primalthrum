#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${PRODUCTION_ENV_FILE:-$ROOT/deploy/production.env.example}"
COMPOSE_FILE="$ROOT/docker-compose.production.yml"
AGENT_CONTAINER="primalthrum-agent-image-smoke-$$"
WEB_CONTAINER="primalthrum-web-image-smoke-$$"

cleanup() {
  docker rm --force "$AGENT_CONTAINER" "$WEB_CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

service_image() {
  local service="$1"
  compose config --format json | node -e \
    "let input='';process.stdin.on('data',c=>input+=c).on('end',()=>process.stdout.write(JSON.parse(input).services['$service'].image))"
}

wait_for_exec() {
  local container="$1"
  shift
  for _ in $(seq 1 30); do
    if docker exec "$container" "$@" >/dev/null 2>&1; then
      return
    fi
    sleep 1
  done
  docker logs "$container" >&2 || true
  return 1
}

assert_image_config() {
  local image="$1"
  local user version
  user="$(docker image inspect --format '{{.Config.User}}' "$image")"
  version="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$image")"
  if [[ -z "$user" || "$user" == "0" || "$user" == "root" ]]; then
    echo "[production-image] $image must define a non-root user" >&2
    exit 1
  fi
  if [[ -z "$version" || "$version" == "<no value>" || "$version" == "dev" || "$version" == "latest" ]]; then
    echo "[production-image] $image must carry a release version label" >&2
    exit 1
  fi
}

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  echo "[production-image] Build immutable images"
  compose build --pull
fi

AGENT_IMAGE="$(service_image agent)"
SERVER_IMAGE="$(service_image server)"
WEB_IMAGE="$(service_image web)"
for image in "$AGENT_IMAGE" "$SERVER_IMAGE" "$WEB_IMAGE"; do
  assert_image_config "$image"
done

echo "[production-image] Agent runtime"
docker run --detach --rm --name "$AGENT_CONTAINER" \
  --read-only --init --cap-drop ALL --security-opt no-new-privileges:true \
  --tmpfs /tmp:size=128m,mode=1777 \
  "$AGENT_IMAGE" >/dev/null
wait_for_exec "$AGENT_CONTAINER" python -c \
  "import json,os,urllib.request; data=json.load(urllib.request.urlopen('http://127.0.0.1:8000/ready',timeout=3)); assert data['status']=='ready'; assert os.getuid()!=0"
docker exec "$AGENT_CONTAINER" python -c \
  "import errno; exec(\"try:\\n open('/image-write-probe','w').close()\\n raise AssertionError('root filesystem is writable')\\nexcept OSError as error:\\n assert error.errno == errno.EROFS\")"
docker stop "$AGENT_CONTAINER" >/dev/null

echo "[production-image] Web runtime"
docker run --detach --rm --name "$WEB_CONTAINER" \
  --read-only --init --cap-drop ALL --security-opt no-new-privileges:true \
  --tmpfs /tmp:size=128m,mode=1777 \
  "$WEB_IMAGE" >/dev/null
wait_for_exec "$WEB_CONTAINER" node -e \
  "fetch('http://127.0.0.1:8080/healthz').then(async response=>{const data=await response.json();if(!response.ok||data.status!=='ok'||process.getuid()===0)process.exit(1)}).catch(()=>process.exit(1))"
docker exec "$WEB_CONTAINER" node -e \
  "const fs=require('fs');try{fs.writeFileSync('/image-write-probe','x');process.exit(1)}catch(error){if(error.code!=='EROFS')process.exit(1)}"
docker stop "$WEB_CONTAINER" >/dev/null

echo "[production-image] OK"
