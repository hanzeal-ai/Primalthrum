# Security And Release Checklist

Use this checklist before tagging or deploying a commercial Primalthrum build.

## Security Checklist

- Admin setup is complete and no default password is used.
- Browser sessions are protected by `HttpOnly` cookies or bearer tokens.
- Every Workspace role can enroll account-level MFA; login and invitation paths
  issue no Session before the bounded second-factor challenge succeeds.
- TOTP replay, recovery-code replay, challenge expiry, five-attempt lockout, and
  other-Session revocation have passing automated evidence.
- Provider secrets are stored only as server-side secret references.
- Workspace API Keys are scoped, expiring, hashed at rest, and returned in
  plaintext only once after password reauthentication.
- Revoked Keys and Sessions fail on their next authenticated request, and API
  Key use creates immutable method/path audit evidence without payloads.
- Retention changes require role, plan entitlement, and password reauthentication;
  active runs, billing evidence, and security audit archives survive enforcement.
- A retention smoke run proves tenant-scoped metadata deletion and physical
  document removal without leaving a pending file-deletion outbox backlog.
- Production startup fails without a private ClamAV service, and clean, rejected,
  and scanner-error upload paths have passing HTTP and immutable audit evidence.
- Provider endpoints reject credentials, non-HTTPS URLs, query/fragment ambiguity,
  private/reserved literals, metadata hostnames, and private or mixed DNS answers.
- Runtime egress permits only approved Provider destinations. ClamAV, the Python
  Agent service, cloud metadata ranges, RFC1918, and link-local networks are not
  reachable through customer-configurable Provider URLs.
- Account and Workspace exports require current-password reauthentication,
  preserve tenant scope, and contain no password, token, MFA recovery, or Secret
  material. Export completion has immutable evidence.
- Account deletion enforces its grace period and paid/shared-ownership blockers,
  revokes every Session and user-created API Key, deletes physical knowledge
  files, anonymizes identity data, and preserves billing/legal evidence.
- Workspace ownership transfer requires Owner permission, current-password
  reauthentication, exact target confirmation, one active Owner, and immutable evidence.
- Legal holds are restricted to Super Admin and Security, immediately block
  retention and member account deletion, require a different Operator for
  release, and preserve immutable case, lifecycle, and minimized audit evidence.
- Production startup rejects local document storage and non-TLS S3 endpoints.
  Bucket access is private and prefix-scoped, versioning and encryption are on,
  and external lifecycle rules cannot expire legally held versions.
- API clients show standardized `error.code`, `error.message`, and `error.status` without exposing secrets.
- Public endpoints are limited to liveness, readiness, metrics, setup, auth, and documented public flows.

## Secrets Checklist

- No real provider keys are committed to the repository.
- `.env.example` files contain placeholders only.
- Provider config API responses redact `secretRef` and never return secret values.
- Transactional email credentials and Webhook secrets are server-only and rotated
  after any suspected exposure.
- `PRIMALTHRUM_SECRET_KEY` is supplied by the production secret manager, backed
  up under dual control, and differs from the development fallback.
- Backup archives are stored in an operator-controlled location.
- Restore access is limited to trusted operators.

## Dangerous Tools Checklist

- Dangerous tools are visible in the web console before agent creation.
- Operators review enabled tools before running customer workflows.
- New tools declare name, description, input schema, and danger policy.
- Dangerous tool behavior is documented in `docs/TOOL_SKILL_AUTHORING_GUIDE.md`.

## Backup Checklist

- `scripts/backup-restore-smoke.sh` exits 0.
- A fresh backup exists before release deployment.
- Restore has been tested on a temporary database and document directory.
- Document storage location is durable and outside ephemeral build directories.
- `scripts/object-storage-smoke.sh` exits 0 with object version and delete-marker evidence.
- The production bucket restore exercise is paired with its database snapshot and succeeds.

## Documentation Checklist

- `docs/INSTALL_GUIDE.md` exists.
- `docs/UPGRADE_GUIDE.md` exists.
- `docs/BACKUP_RESTORE.md` exists.
- `docs/USER_WORKFLOW_GUIDE.md` exists.
- `docs/TROUBLESHOOTING.md` exists.
- `docs/API_KEYS_AND_SESSIONS.md` exists.
- `docs/DATA_RETENTION.md` exists.
- `docs/ACCOUNT_PRIVACY_RIGHTS.md` exists.
- `docs/LEGAL_HOLDS.md` exists.
- `docs/MFA_SECURITY.md` exists.
- `docs/DEMO_RESEARCH_AGENT.md` exists.

## Operator Preflight

Run:

```bash
scripts/commercial-smoke.sh
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/ready
```

Confirm:

- At least one admin can sign in.
- At least one provider config exists.
- At least one demo agent can be created.
- At least one document can be registered and indexed.
- At least one stream run completes.
- A browser upload-to-RAG run renders the indexed document as a message source.
- If voice is enabled, real STT/TTS credentials complete one microphone and playback round trip on each supported browser family.
- Denied microphone permission leaves text input usable and displays an actionable error.
- `/metrics` returns Prometheus text.
- Registration verification and password reset reach real production mailboxes.
- A signed Provider Webhook records delivered and test-bounce events exactly once.
- `primalthrum_account_email_outbox{status="dead_lettered"}` is zero and bounce,
  complaint, retry backlog, and dead-letter alerts are active.
- Production Turnstile hostname/action checks pass for registration and public
  Agent streams, including SSE reconnect with the same idempotency key.
- `TRUSTED_PROXY_HOPS` matches the deployed ingress chain and spoofed forwarding
  headers cannot change the rate-limit subject.
- Rate-limit and challenge-outage alerts are active with no raw identity labels.
- A least-privilege API Key passes its allowed Agent call, fails a missing-scope
  call, cannot access settings, and fails every call after revocation.
- An MFA test identity completes authenticator login and one recovery-code login;
  reused values fail, and an invitation remains pending until MFA succeeds.
- A Business or Enterprise test Workspace saves and enforces a finite retention
  policy while a second Workspace and active runs remain unchanged.
- An EICAR test upload returns `DOCUMENT_THREAT_DETECTED` without creating a
  document or charging storage, and a stopped ClamAV returns
  `DOCUMENT_SCAN_UNAVAILABLE` without accepting the upload.
- A Provider endpoint resolving to any private or metadata address is rejected
  before network transport, including mixed public/private DNS answers.
- Account and Workspace export archives pass a forbidden-field scan, and a
  deletion smoke run proves cancellation, due execution, Session revocation,
  credential removal, physical file deletion, and immutable transition evidence.
- A legal-hold smoke run proves automatic and manual retention delete zero rows,
  queued physical file deletion remains pending, every active member is blocked
  from account deletion, self-release fails, and a second authorized Operator can
  release the current revision without case details entering customer UI or
  Operator audit metadata.
- `/ready` reports `document_storage=ok`, and a production-like S3 failure removes
  the server from traffic without exposing credentials or provider response bodies.

## Known Limitations

- SQLite is the default local metadata store; Postgres is documented as a persistence path but not the default runtime.
- Existing `local://` documents require a controlled content/reference migration
  before switching provider; no automatic local-to-S3 migration is included yet.
- Demo provider config uses mock model defaults unless operators configure real LLM and embedding providers.
- Metrics are in-memory process counters and reset on server restart.
