# Transactional Email Operations

Primalthrum sends account verification and password recovery through a durable
Outbox. Customer requests only enqueue messages; a dispatcher claims them with a
five-minute lease and sends them with the stable idempotency key
`primalthrum-account-email-<outbox-id>`.

## Provider Configuration

Direct Resend delivery is the recommended production configuration:

```dotenv
NODE_ENV=production
PUBLIC_APP_URL=https://app.example.com
TRANSACTIONAL_EMAIL_PROVIDER=resend
TRANSACTIONAL_EMAIL_API_KEY=re_replace_me
TRANSACTIONAL_EMAIL_FROM=Primalthrum <no-reply@example.com>
TRANSACTIONAL_EMAIL_WEBHOOK_SECRET=whsec_replace_me
```

Set `TRANSACTIONAL_EMAIL_URL`, `TRANSACTIONAL_EMAIL_TOKEN`, and provider `http`
to use a compatible relay. The relay must accept the documented JSON message,
honor `Idempotency-Key`, and return a JSON `id`, `messageId`, or `data.id`.

Production startup fails unless the provider, credentials, From identity, and
Webhook secret are all present. Development without a provider uses local action
URL previews. Never enable preview URLs in production.

## Signed Delivery Webhook

Configure the provider to send events to:

```text
POST https://api.example.com/api/webhooks/email
```

The endpoint verifies the Svix-compatible `svix-id`, `svix-timestamp`, and
`svix-signature` headers with a five-minute replay window. It accepts sent,
delivered, delayed, bounced, complained, and failed events. Event IDs are
idempotent, and persisted delivery evidence is immutable. Recipient addresses
and provider payloads are deliberately not copied into the event table.

## Retry And Dead Letters

- HTTP 408, 425, 429, network failures, timeouts, and 5xx responses retry.
- Provider `Retry-After` is honored up to one hour.
- Other 4xx responses are permanent failures.
- Retry delay is exponential and capped at one hour.
- A message enters the dead-letter state after eight attempts or a permanent
  failure. It is excluded from automatic claiming.

## Monitoring

`GET /metrics` exports provider event counters and current Outbox gauges under:

- `primalthrum_account_email_events_total{outcome=...}`
- `primalthrum_account_email_outbox{status=...}`

Alert immediately when `dead_lettered` or `complained` is greater than zero,
when `retrying` remains nonzero for 15 minutes, or when the bounce ratio rises
above the sending-domain baseline. Logs use `ACCOUNT_EMAIL_*` codes and contain
Outbox and Provider IDs but not tokens or email content.

## Production Verification

Before release, use a mailbox on each supported domain to complete registration,
verification, forgot-password, and reset-password. Confirm Provider acceptance,
Webhook delivery, database evidence, and the final user flow. Then force a test
bounce and confirm the `bounced` gauge and alert. Passing automated tests proves
the integration contract, not live DNS reputation or mailbox delivery.

Accepted, superseded, and dead-lettered Outbox records immediately discard their
one-time action payload. Immutable Provider events retain only bounded Provider
IDs, event state, and timestamps; they do not foreign-key block later account
erasure.
