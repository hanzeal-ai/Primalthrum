# Operator Control Plane

Primalthrum exposes a separate operations application at `/operator`. Operator
identities and sessions are not Workspace users or customer sessions. An Operator
Bearer token cannot call customer APIs, and a customer token cannot call Operator
APIs.

## Bootstrap

Generate a random value containing at least 32 bytes and set it only on the Node
server:

```bash
openssl rand -base64 48
export OPERATOR_BOOTSTRAP_TOKEN='<generated value>'
```

Open `/operator`, enter the token, and create the first Super Admin. Bootstrap is
database-enforced as a one-time operation. Remove or rotate the environment value
after setup; never expose it through a `VITE_` variable.

Every later Operator account is created by a Super Admin with a temporary password
of at least 16 characters. All temporary accounts are blocked from platform data
until they replace that password. Password replacement revokes every prior
Operator session and returns one new 12-hour session.

## Roles

| Role | Overview / Workspaces | Customers | Billing | Runtime | Abuse | Flags / Incidents | Operators | Support | Audit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Super Admin | Read | Read | Read | Read | Read | Manage | Manage | Grant/use | Read |
| Support | Read | Read | None | Read | None | Read | Read | Assigned grants only | None |
| Billing | Read | None | Read | None | None | Read | None | None | None |
| Security | Read | Read | None | Read | Read | Manage | Read | Grant/revoke | Read |
| Viewer | Read | None | None | None | None | Read | None | None | None |

Server authorization is authoritative. Web navigation mirrors the same matrix but
is not a security boundary.

## Operational Data Minimization

Global customer and runtime views are for triage, not customer impersonation.
Customer users are represented by a stable `USR-xxxxxx` reference without email.
Agents are represented by `AGT-xxxxxx` without name, slug, description, source
path, configuration, or Provider binding. Jobs expose scheduling, status, and an
error-presence flag without payload, result, or error text.

Billing views expose plan/state, monthly meter aggregates, invoice/refund amounts,
and failed Webhook status. Provider customer, subscription, invoice, payment,
refund, and event references; hosted URLs; raw Webhook payloads; and error text
are excluded. Abuse events exclude subject hashes and request metadata. Every
successful domain read creates an immutable Operator audit event.

## Support Access

Support access is never implicit and does not impersonate a customer. A grant must
bind all of the following:

- one active Support or Super Admin Operator;
- one existing Workspace;
- an approved ticket reference and a 12-500 character reason;
- explicit metadata, Agent count, failed Job count, or billing-summary scopes;
- an expiry between five minutes and four hours.

Only Super Admin and Security can create or revoke grants. Only the assigned
Operator can open an active grant. Expired and revoked grants remain durable and
cannot be deleted. The support context returns aggregate operational state only;
it excludes user email, message content, documents, Provider secrets, payment
payloads, password hashes, and session hashes.

## Change Control

Feature Flags are platform controls, not customer configuration. Every Operator
role can inspect current state and immutable history; only Super Admin and
Security can create or update a Flag, add or revoke a Workspace override, or
change an incident. A kill switch always evaluates false. An active Workspace
override takes precedence over global enablement and deterministic percentage
rollout. Concurrent writes must include the current revision and stale writes are
rejected.

Incidents have an explicit `SEV1`-`SEV4` severity, platform, multi-Workspace, or
single-Workspace impact scope, and an investigating, identified, monitoring, or
resolved state. Resolution records a timestamp; reopening returns the incident to
investigating. Status changes, notes, mitigations, and customer updates are
append-only timeline events. Flag reasons, incident summaries, and timeline text
must contain operational metadata only, never credentials, customer message
content, document text, payment payloads, or Provider secrets.

## Audit

Operator login outcomes, password replacement, account creation, authorization
denial, platform reads, support grant creation/revocation, and every support
context read create immutable events. Metadata filtering removes keys associated
with passwords, tokens, secrets, authorization, cookies, payloads, and content.
Database triggers reject audit updates and deletion.

## API Surface

- `GET /api/operator/setup/status`
- `POST /api/operator/setup`
- `POST /api/operator/auth/login`
- `GET /api/operator/auth/session`
- `PUT /api/operator/auth/password`
- `POST /api/operator/auth/logout`
- `GET /api/operator/overview`
- `GET /api/operator/workspaces`
- `GET /api/operator/workspaces/:id`
- `GET /api/operator/customer-users`
- `GET /api/operator/subscriptions`
- `GET /api/operator/usage`
- `GET /api/operator/payments`
- `GET /api/operator/agents`
- `GET /api/operator/jobs`
- `GET /api/operator/abuse-events`
- `GET/POST /api/operator/feature-flags`
- `PUT /api/operator/feature-flags/:id`
- `GET /api/operator/feature-flags/:id/events`
- `POST /api/operator/feature-flags/:id/overrides`
- `POST /api/operator/feature-flags/:id/overrides/:overrideId/revoke`
- `GET/POST /api/operator/incidents`
- `GET/PUT /api/operator/incidents/:id`
- `POST /api/operator/incidents/:id/events`
- `GET/POST /api/operator/operators`
- `GET/POST /api/operator/support-grants`
- `DELETE /api/operator/support-grants/:id`
- `GET /api/operator/support-grants/:id/context`
- `GET /api/operator/audit`

Customer, billing, Agent, and Job endpoints accept an optional positive
`workspaceId` query filter and a bounded `limit` of at most 200. The abuse event
endpoint accepts the same bounded `limit` without a Workspace filter because its
stored subjects are intentionally one-way hashes with no retained Workspace link.

Operator setup and login use the same durable IP/identity abuse protection as the
public authentication surfaces. Do not publish `/metrics` or the internal Python
Agent service through the Operator application ingress.
