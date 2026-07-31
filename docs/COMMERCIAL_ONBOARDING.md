# Commercial Onboarding

## Registration Contract

`POST /api/auth/register` accepts:

```json
{
  "email": "owner@example.com",
  "password": "at least 12 characters",
  "workspaceName": "Acme Agents",
  "planKey": "pro"
}
```

`planKey` is either `free` or `pro`. Pro registration activates the configured
one-time trial and its credit grant. Free registration provisions the baseline
free subscription and credits. A successful response includes the Owner user,
Workspace, Session, Trial when applicable, current entitlement snapshot, and
credit account.

Email is globally unique. Duplicate or concurrent duplicate registration returns
`409 ACCOUNT_ALREADY_EXISTS`. Registration creates a new Workspace and never
adds the customer to the installation's default Workspace.

## Remaining Release Gates

- Email ownership verification and transactional email delivery.
- Password reset, abuse throttling, bot protection, and account recovery.
- Public product, pricing, signup, login, legal, and onboarding UI.
- Signup funnel analytics with consent controls.
