# Security And Release Checklist

Use this checklist before tagging or deploying a commercial Primalthrum build.

## Security Checklist

- Admin setup is complete and no default password is used.
- Browser sessions are protected by `HttpOnly` cookies or bearer tokens.
- Provider secrets are stored only as server-side secret references.
- API clients show standardized `error.code`, `error.message`, and `error.status` without exposing secrets.
- Public endpoints are limited to liveness, readiness, metrics, setup, auth, and documented public flows.

## Secrets Checklist

- No real provider keys are committed to the repository.
- `.env.example` files contain placeholders only.
- Provider config API responses redact `secretRef` and never return secret values.
- Transactional email credentials and Webhook secrets are server-only and rotated
  after any suspected exposure.
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

## Documentation Checklist

- `docs/INSTALL_GUIDE.md` exists.
- `docs/UPGRADE_GUIDE.md` exists.
- `docs/BACKUP_RESTORE.md` exists.
- `docs/USER_WORKFLOW_GUIDE.md` exists.
- `docs/TROUBLESHOOTING.md` exists.
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

## Known Limitations

- SQLite is the default local metadata store; Postgres is documented as a persistence path but not the default runtime.
- Local document storage is the default file provider; object storage remains a future provider extension.
- Demo provider config uses mock model defaults unless operators configure real LLM and embedding providers.
- Metrics are in-memory process counters and reset on server restart.
