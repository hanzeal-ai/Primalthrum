# Workspace Ownership Transfer

Primalthrum uses a dedicated ownership operation instead of allowing the generic
member-role endpoint to assign or remove the Owner role.

## Customer Flow

The current Owner opens `/app/team`, selects the crown action for an active
member, enters that member's exact email address, and confirms the current Owner
password. The change is immediate:

- the selected active member becomes `owner`;
- the previous Owner becomes `admin`;
- existing Sessions observe the new roles on their next authenticated request;
- invitations, seat accounting, subscription state, and Workspace resources stay intact.

This flow resolves the shared-Workspace blocker before the former Owner requests
account deletion.

## API Contract

`PUT /api/workspaces/:id/ownership` accepts:

```json
{
  "targetUserId": 42,
  "confirmTargetEmail": "successor@example.com",
  "password": "current-owner-password"
}
```

The endpoint accepts browser Sessions only. The requested Workspace must be the
Session's current Workspace, the caller must hold `workspace.manage` as its active
Owner, and the target must be another active member of the same Workspace.
Cross-Workspace target IDs return `404` without exposing account details.

Successful responses include the opaque audit event ID, transfer time, former
Owner membership, and new Owner membership. Passwords are never passed to the
Repository or stored in ownership evidence.

## Database Guarantees

Migration `031_workspace_ownership_transfer` adds a partial unique index that
permits at most one active Owner per Workspace. The transfer runs under
`BEGIN IMMEDIATE`, writes its event only while the expected current Owner and
target member are still valid, then performs both role changes in the same
transaction.

`workspace_ownership_events` stores only Workspace and actor IDs plus time and an
opaque event ID. Database triggers reject all updates and deletions. Production
audit export should treat this table as retained security and governance evidence.
