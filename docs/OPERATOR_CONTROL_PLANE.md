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

| Role | Platform overview | Workspaces | Billing | Operators | Support | Audit |
| --- | --- | --- | --- | --- | --- | --- |
| Super Admin | Read | Read | Read | Manage | Grant/use | Read |
| Support | Read | Read | None | Read | Assigned grants only | None |
| Billing | Read | Read | Read | None | None | None |
| Security | Read | Read | None | Read | Grant/revoke | Read |
| Viewer | Read | Read | None | None | None | None |

Server authorization is authoritative. Web navigation mirrors the same matrix but
is not a security boundary.

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
- `GET/POST /api/operator/operators`
- `GET/POST /api/operator/support-grants`
- `DELETE /api/operator/support-grants/:id`
- `GET /api/operator/support-grants/:id/context`
- `GET /api/operator/audit`

Operator setup and login use the same durable IP/identity abuse protection as the
public authentication surfaces. Do not publish `/metrics` or the internal Python
Agent service through the Operator application ingress.
