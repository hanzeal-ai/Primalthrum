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

`planKey` is either `free` or `pro`. Registration provisions baseline Free
entitlements and creates pending email verification. A successful response
includes the Owner user, Workspace, Session, verification requirement, current
entitlement snapshot, and credit account. The selected Pro trial and its credit
grant start only after email ownership is verified.

Email is globally unique. Duplicate or concurrent duplicate registration returns
`409 ACCOUNT_ALREADY_EXISTS`. Registration creates a new Workspace and never
adds the customer to the installation's default Workspace.

## Remaining Release Gates

- Transactional email provider credentials and live delivery verification.
- Abuse throttling, bot protection, and assisted account recovery.
- Signup funnel analytics with consent controls.
- Final privacy and terms review by qualified legal counsel.

## Public Web Surfaces

- `/`: product home with an Agent intent composer and real product visual.
- `/pricing`: live plan catalog sourced from `GET /api/public/plans`.
- `/signup`: Free or Pro registration and immediate Workspace handoff.
- `/login`: existing account access.
- `/verify-email`: pending, resend, and one-time verification completion.
- `/forgot-password` and `/reset-password`: enumeration-safe account recovery.
- `/security`, `/docs`, `/contact`, and `/status`: product trust and help pages.
- `/legal/privacy` and `/legal/terms`: clearly labeled pre-release legal surfaces.

An Agent description entered on the public home is stored for the browser session
and consumed by the builder after successful registration. The new customer lands
at the first required model choice instead of repeating their request.
