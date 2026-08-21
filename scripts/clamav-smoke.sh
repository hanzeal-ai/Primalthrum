#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN_ID="${$}"
CONTAINER="primalthrum-clamav-smoke-${RUN_ID}"
PORT="${CLAMAV_SMOKE_PORT:-43310}"
IMAGE="${CLAMAV_IMAGE:-clamav/clamav-debian@sha256:2bb8cd7dfe3e87f86e969a2c415f7698583175e46dc2234672be9210c982c144}"

cleanup() {
  docker rm --force "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run --detach --rm \
  --name "$CONTAINER" \
  --publish "127.0.0.1:${PORT}:3310" \
  "$IMAGE" >/dev/null

READY=0
for _ in $(seq 1 180); do
  if node -e "
    const net=require('node:net');
    const socket=net.createConnection({host:'127.0.0.1',port:${PORT}});
    let response='';
    const timer=setTimeout(()=>process.exit(1),1000);
    socket.on('connect',()=>socket.write(Buffer.from('zPING\\0')));
    socket.on('data',chunk=>{
      response+=chunk.toString('utf8');
      if(response.includes('\\0')){
        clearTimeout(timer);
        socket.destroy();
        process.exit(response.replace(/[\\0\\r\\n]+/g,'').trim()==='PONG'?0:1);
      }
    });
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
  CLAMAV_HOST=127.0.0.1 \
  CLAMAV_PORT="$PORT" \
  CLAMAV_TIMEOUT_MS=10000 \
  pnpm exec ts-node src/commands/clamAvSmoke.ts
)
