# API Keys And Session Security

Workspace API Keys authenticate server-to-server Agent operations through the
same Bearer header used by the canonical API:

```http
Authorization: Bearer ptk_prefix_secret
```

## Key Lifecycle

- Owner and Admin can list, create, and revoke Workspace API Keys.
- Creation requires the current account password and returns the plaintext Key
  once. List responses never contain it.
- The database stores only SHA-256 token hashes and a non-secret display prefix.
- Keys require at least one scope and expire after 1 to 365 days. The Web offers
  30-day, 90-day, and one-year choices.
- A Workspace can have at most 20 active Keys.
- Revocation takes effect on the next request. Removing the creator from the
  Workspace also invalidates Keys created by that user.

Supported scopes:

| Scope | Server permission |
| --- | --- |
| `agents:read` | Read Agents, versions, conversations, runs, and jobs |
| `agents:write` | Create Agents, drafts, documents, and indexes |
| `agents:run` | Create conversations, runs, events, and streams |
| `agents:publish` | Publish, roll back, and change Agent audience |

API Keys are rejected on account, billing, team, Provider, Workspace, and
settings routes even when the creating user could access those routes in the Web.
Every allowed API Key request updates last-use metadata and appends an immutable
`api_key_usage_events` record with only Key ID, Workspace ID, method, path, and
timestamp. Tokens and request payloads are never audit fields.

## Session Security

`/app/settings` lists every active, unexpired browser Session for the current
user. A user can revoke one other Session or revoke all other Sessions while the
current Session remains active. The server rejects attempts to revoke the current
Session through these controls. Password reset continues to revoke all Sessions.

## Release Checks

1. Create a least-privilege Key and save the one-time value.
2. Verify an allowed Agent request succeeds and a missing-scope mutation returns
   `403 API_KEY_SCOPE_FORBIDDEN`.
3. Verify account and settings routes reject the Key.
4. Confirm the token value does not occur in the database, logs, or API list.
5. Confirm a usage event exists, revoke the Key, and verify the next request is 401.
6. Create a second browser Session, revoke it from `/app/settings`, and verify it
   can no longer access `/api/auth/session`.

MFA, device/IP labeling, customer retention enforcement, and managed signing or
HMAC keys remain later security milestones and are not claimed by this feature.
