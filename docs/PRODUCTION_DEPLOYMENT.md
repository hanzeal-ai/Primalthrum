# Production Deployment

Primalthrum ships a production-only Compose topology separately from the local
development stack. It builds immutable Agent, Server, Worker, and Web images and
does not install packages or mount source code while containers are starting.

## External Dependencies

Provision these services before deployment:

- PostgreSQL with TLS, automated backups, and point-in-time recovery.
- S3-compatible object storage exposed through HTTPS with bucket versioning.
- ClamAV reachable from the Server and Worker network.
- An OpenTelemetry collector with an HTTPS OTLP/HTTP traces endpoint and retained access controls.
- Stripe, transactional email, and Cloudflare Turnstile production credentials.
- A TLS reverse proxy or load balancer in front of the Web container.

Copy `deploy/production.env.example` to the release environment file and replace
every non-secret placeholder. The file stores external secret names, not secret
values. Provision every `*_SECRET_NAME` entry in the deployment platform before
starting the stack; Compose mounts those values only into Server and Worker under
`/run/secrets`. Do not commit the populated environment file. The value stored for
`DATABASE_URL_SECRET_NAME` must be a PostgreSQL URL with URL-encoded credentials.

Mounted secret files must be regular files, no larger than 64 KiB, and not writable
by group or other users. Each file contains one non-empty value with an optional
trailing newline. Startup fails when a direct secret environment variable and its
`*_FILE` variant are both configured, so deployments cannot silently select the
wrong source.

The base topology omits optional provider credentials such as S3 session tokens,
custom email bearer tokens, and usage-export tokens. A deployment that enables one
must add its secret mount and matching `*_FILE` variable in a platform-specific
Compose override; do not place the value in the release environment file.

## Validate And Build

Render and validate the deployment without starting containers:

```bash
docker compose --env-file deploy/production.env \
  -f docker-compose.production.yml config --quiet
```

The release gate performs the same topology checks against the safe example file:

```bash
bash scripts/production-deployment-smoke.sh
```

It rejects host source mounts, writable application roots, missing health checks,
unversioned images, excess host ports, absent process hardening, disabled OTLP tracing,
an insecure collector endpoint, duplicate Server/Worker service identities, direct
secret environment values, or missing external secret mounts.

Build the release images and verify their version labels, non-root users, read-only
runtime roots, and Agent/Web health endpoints:

```bash
bash scripts/production-image-smoke.sh
```

Set `SKIP_BUILD=1` only when the exact images rendered by the production Compose
configuration have already been built in the same release job.

Verify that the production OTLP/HTTP JSON emitted for both service identities is
accepted by a fixed-digest OpenTelemetry Collector over TLS:

```bash
bash scripts/otel-collector-smoke.sh
```

Build immutable images with the release version:

```bash
IMAGE_TAG=$(cat VERSION) docker compose --env-file deploy/production.env \
  -f docker-compose.production.yml build --pull
```

Run image vulnerability and secret scans in CI before publishing the images.
The application containers run as non-root users with read-only root filesystems,
all Linux capabilities dropped, and `no-new-privileges` enabled.

## Start And Verify

Before deploying, run the complete production startup smoke. It provisions real
PostgreSQL, TLS MinIO, ClamAV, and a TLS OpenTelemetry Collector, starts the release
Agent, Server, Worker, and Web images, waits for every health gate, and verifies the
Web-proxied public Plan catalog:

```bash
bash scripts/production-startup-smoke.sh
```

Set `SKIP_BUILD=1` only when `scripts/production-image-smoke.sh` already verified
the same `IMAGE_PREFIX` and `IMAGE_TAG` in the current release job.

```bash
docker compose --env-file deploy/production.env \
  -f docker-compose.production.yml up -d
docker compose --env-file deploy/production.env \
  -f docker-compose.production.yml ps
```

Only the Web container binds a host port. It serves the built SPA, proxies `/api`
to the Server, and preserves streaming responses. Place TLS termination in front
of `${WEB_BIND_ADDRESS}:${WEB_PORT}`. The Server and Agent must report ready before
dependents start. Worker health requires both a running Worker process and a
successful PostgreSQL query.

Set `TRUSTED_PROXY_HOPS` to the exact number of trusted proxies between the public
client and Server. The supplied topology expects a TLS proxy followed by the Web
proxy, so the example uses `2`. `FORWARDED_PROTO` must match the public scheme.

With the required production tracing configuration, Server requests propagate W3C
`traceparent` only to the internal Agent capability, Embedding, speech, and stream
endpoints. Keep `AGENT_BASE_URL` on a trusted private network; external provider calls
do not receive this internal correlation header.

The Worker service exports Durable Job, account-email Outbox, and usage-export Outbox
Consumer Spans using `OTEL_WORKER_SERVICE_NAME`. Shutdown drains in-flight deliveries
before flushing the shared bounded exporter queue.

Verify from outside the deployment boundary:

```bash
curl --fail https://agents.example.com/healthz
curl --fail https://agents.example.com/api/public/plans
```

Scale Workers independently from HTTP replicas:

```bash
docker compose --env-file deploy/production.env \
  -f docker-compose.production.yml up -d --scale worker=3
```

Durable Job leases and Outbox claims prevent concurrent Workers from completing
the same record. During shutdown, Workers stop new claims and wait for in-flight
delivery before the container exits.

## Rolling Deployments

Bring up replacement Web and Server replicas with the new immutable image before
removing old replicas. The external load balancer must wait for `/healthz` and the
proxied Server `/ready` check before routing traffic, then stop assigning new traffic
to an old Web instance before sending its termination signal. The Web process stops
accepting connections on shutdown but lets active static and proxied streaming
responses finish before it exits.

`pnpm --dir web test:production-server` includes an in-process rolling handoff: a
replacement Web instance becomes healthy and serves an API request while the old
instance drains an unfinished proxied stream, and the old instance closes only after
the final stream chunk is delivered. The Server lifecycle has a matching request-drain
test: it stops accepting connections, waits for the active HTTP response, then runs App
cleanup and closes the database in order; database closure still runs when App cleanup
fails. Production acceptance must repeat both handoffs through the selected external
load balancer.

The reference external-ingress gate repeats the Web handoff through a hardened,
fixed-digest Nginx HTTPS proxy:

```bash
bash scripts/external-ingress-rolling-smoke.sh
```

It switches new traffic to the replacement Web, stops the old Web, and requires the
already-open proxied stream to deliver its final chunk. Repeat the same sequence on the
selected production ingress before release.

## Rollback

Keep the previous immutable `IMAGE_TAG` available. Before changing application
versions, complete the database backup and restore checks in `docs/BACKUP_RESTORE.md`.
PostgreSQL migrations are forward-only, so an application image rollback is valid
only when the previous version supports the migrated schema. Change `IMAGE_TAG`,
render the Compose configuration again, and redeploy. Never restore a database over
the active production database.

The local `docker-compose.yml` remains a development topology and must not be used
as production evidence.
