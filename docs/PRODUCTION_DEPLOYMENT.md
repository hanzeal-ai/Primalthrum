# Production Deployment

Primalthrum ships a production-only Compose topology separately from the local
development stack. It builds immutable Agent, Server, Worker, and Web images and
does not install packages or mount source code while containers are starting.

## External Dependencies

Provision these services before deployment:

- PostgreSQL with TLS, automated backups, and point-in-time recovery.
- S3-compatible object storage exposed through HTTPS with bucket versioning.
- ClamAV reachable from the Server and Worker network.
- Stripe, transactional email, and Cloudflare Turnstile production credentials.
- A TLS reverse proxy or load balancer in front of the Web container.

Copy `deploy/production.env.example` to a secret-managed environment file and
replace every placeholder. Do not commit the populated file. `DATABASE_URL`
credentials must be URL-encoded.

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
unversioned images, excess host ports, or absent process hardening.

Build immutable images with the release version:

```bash
IMAGE_TAG=$(cat VERSION) docker compose --env-file deploy/production.env \
  -f docker-compose.production.yml build --pull
```

Run image vulnerability and secret scans in CI before publishing the images.
The application containers run as non-root users with read-only root filesystems,
all Linux capabilities dropped, and `no-new-privileges` enabled.

## Start And Verify

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

## Rollback

Keep the previous immutable `IMAGE_TAG` available. Before changing application
versions, complete the database backup and restore checks in `docs/BACKUP_RESTORE.md`.
PostgreSQL migrations are forward-only, so an application image rollback is valid
only when the previous version supports the migrated schema. Change `IMAGE_TAG`,
render the Compose configuration again, and redeploy. Never restore a database over
the active production database.

The local `docker-compose.yml` remains a development topology and must not be used
as production evidence.
