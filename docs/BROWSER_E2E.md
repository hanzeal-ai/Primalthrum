# Commercial Browser E2E

The Playwright suite is the repeatable browser gate for the commercial Workspace
role contract. It starts an isolated Python Agent, Node API, and Vite Web process,
then creates a temporary SQLite database under `.e2e/`.

## Run

Install the browser runtime once:

```bash
cd web
pnpm exec playwright install chromium
```

Run the complete gate:

```bash
pnpm test:e2e
```

Run one viewport independently:

```bash
pnpm test:e2e --project=desktop-chromium
pnpm test:e2e --project=mobile-chromium
```

## Coverage

- Owner, Admin, Developer, Member, Billing, and Viewer authenticate as real users.
- Accounts are provisioned through the public invitation acceptance contract.
- Desktop navigation and Team, Settings, Billing, and Usage controls match the
  canonical server role matrix.
- Browser-originated API probes verify Agent, Billing, invitation, API Key, and
  retention authorization for every role.
- Billing users land on Billing instead of an unauthorized Agent Builder.
- Mobile navigation is role-correct and Team, Settings, and Billing remain free
  of horizontal overflow and client console errors.

The fixture deletes and recreates `.e2e/` on each run. It never reads or writes
the development database. Playwright reports and traces are ignored by Git and
retained locally only when a test fails.
