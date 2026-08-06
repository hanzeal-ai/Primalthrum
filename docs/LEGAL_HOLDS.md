# Workspace Legal Holds

Primalthrum legal holds preserve all retention-controlled customer records for a
Workspace while a litigation, regulatory, investigation, tax, or contractual
obligation is active. Legal holds are an Operator control, not a customer
configuration or plan entitlement.

## Authorization And Separation Of Duties

Only `super_admin` and `security` Operators have `legal_holds.read` and
`legal_holds.manage`. Customer Sessions, Workspace API Keys, Support, Billing,
Viewer, and ordinary Workspace roles cannot access hold cases.

The Operator placing a hold cannot release it. Release requires a second active,
authorized Operator and the current record revision. Stale revisions and maker
self-approval return conflict errors. There is no API, customer setting, or
emergency database bypass for deleting a hold.

## Case Lifecycle

A placed case records one Workspace, a unique external case reference, an
approved basis, a bounded operational reason, the creating Operator, and an
internal hold reference. Multiple active cases can cover one Workspace. The
Workspace remains preserved until every active case is independently released.

Release records the reviewing Operator, a bounded release basis, timestamp, and
incremented revision. The case row cannot be deleted or repurposed. Placed and
released lifecycle events are append-only and database triggers reject updates
or deletion.

## Enforcement Boundary

An active hold atomically changes retention enforcement into an
`enforcement_blocked` event. The transaction does not archive or delete
conversations, runs, documents, jobs, or tool audit rows. Existing physical-file
deletion intents for the Workspace are also withheld. The next enforcement
attempt is scheduled 24 hours later without changing `last_enforced_at`.

Account deletion is blocked for every account with an active membership in the
held Workspace, including non-Owner members. The blocker is checked when the
request is created and immediately before scheduled execution.

Customers see only that a mandatory preservation policy paused cleanup or
account deletion. External case references, internal references, legal basis,
reasons, Operator IDs, release details, and active case count are not rendered in
customer UI.

## Operator Procedure

1. Confirm the Workspace ID and authorization in the approved legal ticket.
2. Open `/operator?view=holds`, select the Workspace, and enter the external case
   reference, basis, and a reason containing no customer content or credentials.
3. Place the hold and verify it is listed as active before acknowledging the
   request.
4. Run the retention smoke check and confirm `enforcement_blocked`, zero deleted
   records, and no processed file-deletion intent.
5. To release, a different Super Admin or Security Operator reviews the source
   authorization, enters the release basis, and submits the current revision.
6. Verify the case is released. If another active case exists, preservation must
   remain active.

If a required reviewer loses access, restore or provision an authorized Security
Operator through the normal audited account process. Do not edit hold tables
directly. Open an incident for any unexpected cleanup, missing case, unauthorized
read, or release conflict. Preserve database backups and Operator audit evidence
with the incident record.

## API

- `GET /api/operator/legal-holds`
- `POST /api/operator/legal-holds`
- `POST /api/operator/legal-holds/:id/release`

Operator audit events store only the hold ID, Workspace ID, basis, and revision.
They intentionally omit external case references, placement/release reasons, and
customer data.

Migration `032_workspace_legal_holds` creates the case and immutable event tables
and expands retention events with `enforcement_blocked`. Back up the metadata
database before migration and verify active holds after every restore.
