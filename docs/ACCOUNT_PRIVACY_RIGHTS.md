# Account Privacy Rights

Primalthrum provides authenticated account and Workspace data portability plus
scheduled account deletion from `/app/settings`. These controls are browser
Session-only and require the current password for every export, deletion, or
cancellation action.

## Data Export

`POST /api/settings/privacy/export` accepts `scope=account` or
`scope=workspace` and returns a versioned JSON attachment.

- Account exports contain the profile, Workspace memberships, Session metadata,
  MFA event history, transactional email delivery state, and privacy requests.
- Workspace exports require the Owner role and contain Agents and configuration,
  versions and deployments, conversations and messages, knowledge documents and
  text, runs and stream events, team records, Provider settings, API Key metadata,
  retention state, invoices, refunds, subscriptions, usage, and ledger evidence.
- Password hashes, Session/API Key tokens, MFA recovery codes, encrypted Secret
  material, and Provider credentials are excluded or redacted.

Each successful export writes an immutable `export_completed` event. Export is
not controlled by a paid-plan entitlement.

## Account Deletion

`POST /api/settings/privacy/deletion` requires the exact account email and the
current password. The request enters a seven-day grace period. During that time,
`DELETE /api/settings/privacy/deletion` can cancel it after reauthentication.

Deletion is blocked when an owned Workspace:

- still has another active member, until ownership is transferred to that member; or
- has an active, trialing, incomplete, or past-due paid subscription.

Deletion is also blocked when the account has any active membership in a
Workspace under legal hold. This applies to Owners, Admins, Members, and Viewers.
The customer receives only a mandatory-preservation message; case details remain
restricted to authorized Operators.

The same blockers are checked again immediately before execution. A durable
`account.delete` job retries three times. Every transition is recorded in the
immutable `account_privacy_events` evidence stream using a one-way subject hash.

## Deletion Result

Execution revokes all account Sessions and API Keys created by the user, removes
password-reset and verification tokens, destroys MFA factors and recovery data,
anonymizes email delivery payloads, and replaces the account email and password
with non-recoverable tombstone values.

Memberships in shared Workspaces become inactive. A Workspace owned only by the
deleted account is closed and its Agents, conversations, runs, knowledge files,
indexes, Provider settings, encrypted Secrets, capabilities, and invitations are
removed. File deletion happens before database finalization and is idempotent.

Billing subscriptions, invoices, refunds, immutable usage/credit ledgers,
security events, and minimized privacy request evidence remain pseudonymous for
contractual, fraud-prevention, tax, and legal-retention obligations. Production
policy must define the exact jurisdiction-specific retention period before
launch. The technical legal-hold process is documented in `docs/LEGAL_HOLDS.md`.

An Owner can resolve the shared-Workspace blocker from `/app/team` without
removing members. The dedicated ownership-transfer flow requires the current
password and exact target member email, immediately demotes the former Owner to
Admin, and preserves the Workspace for the new Owner.

## Operations

- `GET /api/settings/privacy` returns the active deletion request, blockers,
  grace period, and recent request history.
- The privacy scheduler checks due requests every minute and creates at most one
  active durable job per request.
- Failed requests expose a bounded failure reason without payloads or secrets.
- Operators must alert on terminal `failed` requests and complete documented
  manual remediation within the approved data-subject response period.
