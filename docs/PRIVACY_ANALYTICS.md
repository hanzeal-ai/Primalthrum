# Privacy Consent And Product Analytics

Primalthrum uses a first-party, opt-in analytics contract. Analytics is disabled
until a visitor explicitly grants it. Authentication and the stored privacy
choice are classified as necessary functionality and do not imply analytics
consent.

## Public Contract

- `GET /api/public/privacy/config` returns the active policy version and category defaults.
- `POST /api/public/privacy/consents` records a grant, denial, or withdrawal.
- `POST /api/public/analytics/events` accepts an event only when the supplied
  receipt is the latest receipt for the pseudonymous browser subject and grants analytics.

The browser subject and receipt IDs are random UUIDs. The server stores only a
SHA-256 subject hash. Consent receipts and accepted events are append-only.
Changing an event while reusing its event ID returns an idempotency conflict.
When an asynchronous runtime database is configured, consent and analytics use
that shared SQLite or PostgreSQL store. Per-subject transactions serialize grants,
withdrawals, and event acceptance across server instances.

## Data Minimization

The server accepts only these event names:

- `page_view`
- `agent_intent_started`
- `plan_selected`
- `signup_viewed`
- `signup_submitted`
- `signup_completed`
- `email_verification_completed`

Properties are limited to `source`, `planKey`, and `authenticated`. Paths must be
bounded application paths. Email, prompt, Agent content, document content,
payment data, provider credentials, and arbitrary custom properties are rejected.
Event timestamps must be no more than 24 hours old or five minutes in the future.

## Browser Behavior

The first visit displays `Only necessary`, `Accept all`, and preference controls.
The current choice can be reopened from the website footer. A policy-version
change invalidates the local decision and requests consent again. Withdrawal
creates a new receipt and immediately makes every older grant unusable for new events.

The current engineering policy version is `2026-07-31`. Qualified legal review,
regional wording, retention periods, and final production policy publication
remain commercial release gates.
