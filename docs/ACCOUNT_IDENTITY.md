# Account Identity Lifecycle

## Email Verification

New public registrations create an isolated Owner Workspace in `pending_email`
state. The server creates a random 256-bit token, stores only its SHA-256 hash in
`account_action_tokens`, and enqueues a verification message. The token expires
after 24 hours and is consumed atomically once.

Until verification, authenticated product APIs return
`EMAIL_VERIFICATION_REQUIRED`. Session inspection, verification resend, email
confirmation, and logout remain available. Verification marks the email, starts
the selected Pro trial when applicable, and activates onboarding. A resend
invalidates older tokens and supersedes undelivered messages.

## Password Recovery

`POST /api/auth/password/forgot` always returns `202 { accepted: true }`, including
for unknown or unverified addresses. A valid account receives a 30-minute,
single-use reset token. Successful reset replaces the password hash and revokes
every existing Session for that user. Replayed or expired tokens return a generic
reset error.

## Transactional Email

`account_email_outbox` is durable and request-independent. The dispatcher claims
messages with a five-minute lease, records attempts and errors, retries with
exponential delay, and uses `primalthrum-account-email-<id>` as the provider
idempotency key. Configure production delivery with:

- `TRANSACTIONAL_EMAIL_URL`
- `TRANSACTIONAL_EMAIL_TOKEN`
- `TRANSACTIONAL_EMAIL_FROM`

Development may return `emailPreviewUrl` to the local Web client. Production
disables that field and fails startup unless all three external sender variables
are configured.
