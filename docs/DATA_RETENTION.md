# Workspace Data Retention

Primalthrum applies retention per Workspace. New Workspaces retain data
indefinitely until an Owner or Admin explicitly saves a finite policy.

## Customer Controls

The `/app/settings` retention panel manages three independent categories:

- Conversation history: 30 to 3650 days, or indefinite.
- Completed run records and stream events: 7 to 3650 days, or indefinite.
- Uploaded knowledge documents and their index entries: 30 to 3650 days, or indefinite.

Only Owner and Admin roles can change or immediately enforce a policy. Every
mutation requires current-password reauthentication. Custom retention requires
the `retention.controls` entitlement, included by the Business and Enterprise
plans. Other roles can inspect the effective policy and execution history.

Active `pending` and `running` runs are never removed. When an expired
conversation is removed before a newer run, the run is retained and its
conversation reference is cleared.

## Enforcement

Saving a finite policy creates a durable `retention.enforce` job. The server
also checks due Workspaces hourly, while each successful policy execution sets
the next enforcement time to 24 hours later. Operators can use
`POST /api/settings/retention/enforce` for an immediate password-confirmed run.

Database deletion and file-deletion intent are committed in one transaction.
Knowledge file references enter `retention_file_deletions` before document
metadata is removed. The storage deletion worker is idempotent and records
completion or a bounded retry failure, preventing an object-store or filesystem
error from rolling back the metadata policy.

Before an expired run is removed, tool-call audit rows are copied into the
immutable `retained_tool_audit_logs` archive. Existing audit APIs read both live
and archived records.

## Excluded Records

Workspace retention does not delete:

- billing subscriptions, invoices, credit ledger, usage rating, or refund evidence;
- API Key use, authentication Session, abuse-protection, or privacy consent evidence;
- retention policy and enforcement events;
- archived tool security audit records;
- Agents, versions, deployments, Provider configuration, or team membership.

Account and Owner-authorized Workspace export plus scheduled account deletion are
documented in `docs/ACCOUNT_PRIVACY_RIGHTS.md`. Statutory retention schedules,
legal-hold support, and production object-storage lifecycle rules remain part of
the P21 compliance gate. Operators must align those controls with the approved
privacy policy and regional obligations before launch.

## API

- `GET /api/settings/retention`: policy, current deletion preview, entitlement,
  role capability, and recent immutable events.
- `PUT /api/settings/retention`: save a policy after role, entitlement, and
  current-password checks.
- `POST /api/settings/retention/enforce`: run the effective policy immediately
  after the same authorization checks.

All routes are browser-Session-only. Workspace API Keys cannot access settings.
