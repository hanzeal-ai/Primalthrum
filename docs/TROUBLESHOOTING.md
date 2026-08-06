# Troubleshooting

## Server Readiness Fails

Check:

- `sqlite3` is installed and available on `PATH`.
- The metadata DB path is writable.
- The Agent runtime is reachable at `AGENT_BASE_URL`.
- `GET /ready` on the Agent runtime returns 200.
- The configured document bucket is reachable and the credential can access its prefix.

When `document_storage` fails, verify the S3 endpoint, signing region, clock,
bucket, prefix, TLS trust, and secret-manager injection. Application errors expose
only operation and status, so use provider audit logs for the request-level cause.

## Authentication Fails

Clear the browser session token and sign in again. If the first admin was not created, open `/api/setup/status` and confirm `needsSetup`.

## Provider Config Save Fails

Check required fields:

- `name`
- `type`
- `provider`
- `secret` when creating a new config

Server errors return a standard payload with `error.code`, `error.message`, and `error.status`.

## Document Indexing Fails

Check:

- The selected agent exists.
- The document exists and has content.
- Document storage is writable.
- The background job result in `/api/jobs/:id`.

An `outside the configured bucket/prefix` error means the database reference was
created for a different storage configuration. Restore the matching configuration
or run a controlled content/reference migration; do not weaken scope validation.

## Stream Fails

Check:

- The Agent runtime is running.
- `AGENT_BASE_URL` points to the Python service.
- The selected agent exists.
- The browser session is still authenticated.

## Metrics Are Empty

Call any endpoint, then request `/metrics`. HTTP counters are in-memory process counters and reset when the Node server restarts.
