# Abuse Protection

Primalthrum applies request controls before protected business routes execute.
Migration `022_abuse_protection` stores database-atomic fixed-window counters,
short-lived challenge grants, and immutable enforcement evidence. Raw IP
addresses, emails, Session tokens, Turnstile tokens, and prompts are never stored
in these tables; subjects are HMAC-SHA256 values derived with `ABUSE_HASH_SECRET`.

## Production Configuration

```dotenv
NODE_ENV=production
ABUSE_HASH_SECRET=replace-with-at-least-32-random-bytes
TRUSTED_PROXY_HOPS=1
BOT_CHALLENGE_PROVIDER=turnstile
TURNSTILE_SITE_KEY=replace_me
TURNSTILE_SECRET_KEY=replace_me
TURNSTILE_HOSTNAMES=app.example.com
```

Production startup fails closed when the HMAC or Turnstile configuration is
missing. `TRUSTED_PROXY_HOPS` defaults to zero. Primalthrum ignores
`X-Forwarded-For` unless an operator explicitly declares the exact number of
trusted reverse-proxy hops; malformed chains fall back to the socket address.
Production hostname allowlists reject localhost and loopback addresses. Use
Cloudflare's documented testing keys in a separate development environment.

Allow these Turnstile origins in the production Content Security Policy:

- Script: `https://challenges.cloudflare.com`
- Frame: `https://challenges.cloudflare.com`
- Connect: `https://challenges.cloudflare.com`

## Default Controls

| Action | Dimensions | Default policy |
| --- | --- | --- |
| Setup admin | IP | 3/hour |
| Login | IP and normalized email HMAC | 30/10 min and 10/10 min |
| Registration | IP and normalized email HMAC | 5/hour and 3/day, plus Turnstile |
| Verification resend | IP and user | 10/hour and 5/hour |
| Password recovery | IP and normalized email HMAC | 10/hour and 3/hour |
| Invitation acceptance | IP and invitation token SHA-256 | 20/15 min and 10/15 min |
| API Key creation | User | 10/hour |
| Public Agent page | IP | 120/min |
| Public Agent stream | IP and IP+Agent | 10/min and 30/hour, plus Turnstile |
| Authenticated stream | User | 120/hour |
| Document upload | User | 30/hour |
| STT/TTS | User | 120/hour |
| Consent and analytics | IP | 30/min and 120/min |

The limits protect request and provider capacity; billing reservations and
entitlements remain the authoritative commercial quota. Login always performs a
real or sentinel `scrypt` verification so unknown accounts do not expose a
cheaper timing path. Password recovery remains enumeration-safe.

## Challenge And Stream Retry

The Web loads `GET /api/public/abuse/config` and renders Turnstile only when the
server advertises it. Registration and public Agent stream requests send the
token in `X-Bot-Challenge-Token`. Successful public stream verification creates a
10-minute HMAC grant bound to rule, source, and `Idempotency-Key`, allowing SSE
reconnect without reusing the one-time Turnstile token. A different source or key
must complete a new challenge.

## Responses And Monitoring

Rate-limited requests return `429 RATE_LIMIT_EXCEEDED`, `Retry-After`, and
`X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset`. Failed
challenges return `403 BOT_CHALLENGE_REQUIRED`; verifier outages return
`503 BOT_CHALLENGE_UNAVAILABLE` instead of bypassing protection.

`primalthrum_abuse_enforcement_total{rule,outcome}` exposes bounded enforcement
counters. Alert on challenge service outages, sustained rate-limit increases,
and public stream blocks. Investigations should use event IDs and HMAC subjects;
do not add raw identity data to logs or metrics.

Rate-limit Buckets, Challenge Grants, and immutable enforcement evidence use the
configured async runtime database. PostgreSQL atomically increments shared windows,
so separate server instances cannot each grant an independent quota. Per-process
memory is intentionally not used.
