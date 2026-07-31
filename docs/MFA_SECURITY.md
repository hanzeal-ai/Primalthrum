# Multi-Factor Authentication Security

Primalthrum supports account-level time-based one-time passwords (TOTP) for every
Workspace role. MFA belongs to the user identity, not to a Workspace, so changing
the active Workspace or accepting a new invitation cannot bypass it.

## Authentication Contract

- TOTP follows RFC 6238 with HMAC-SHA1, six digits, and a 30-second period.
- Verification accepts the current time step and at most one adjacent step in
  either direction to tolerate bounded clock skew.
- The accepted time step is persisted atomically. A TOTP cannot be accepted more
  than once, even through a different login challenge.
- A valid password creates a five-minute MFA challenge instead of a Session when
  MFA is enabled. The challenge is random, SHA-256 hashed at rest, single use,
  and limited to five failed attempts.
- Successful MFA Sessions record `totp` or `recovery_code` as the authentication
  method and the MFA authentication time.
- Enabling or disabling MFA revokes every other active Session. The current
  Session is upgraded or downgraded in place.

The implementation is validated against the RFC 6238 SHA-1 test vectors. The
window and replay rules follow the current NIST authenticator requirements:

- <https://www.rfc-editor.org/rfc/rfc6238.html>
- <https://pages.nist.gov/800-63-4/sp800-63b.html>

## Enrollment And Recovery

1. Open `/app/settings` and enter the current password under **Multi-factor
   authentication**.
2. Open the generated `otpauth://` link in an authenticator or enter the Base32
   secret manually.
3. Enter the first six-digit code to confirm possession.
4. Store the ten recovery codes offline. They are displayed only in the response
   that creates or replaces them.

Each recovery code contains 120 random bits, is SHA-256 hashed at rest, and is
consumed atomically. Regenerating the set invalidates all previous unused codes.
Closing MFA requires the current password and a valid TOTP or unused recovery
code. Regenerating recovery codes requires the password and TOTP.

There is intentionally no support-agent bypass or email-only MFA reset. Until an
audited identity-recovery workflow is delivered, a user who loses both the
authenticator and every recovery code requires an operator-reviewed database
recovery procedure and incident record.

## Secret Storage

The 160-bit TOTP secret is stored through `LocalSecretVault` with AES-256-GCM.
Production deployments must set a strong, backed-up `PRIMALTHRUM_SECRET_KEY` and
must not use the development fallback. Losing that key makes enrolled factors
unreadable; exposing it requires factor rotation for affected users.

MFA events are immutable and contain event type, user ID, purpose, and attempt
number only. TOTP values, recovery codes, challenge tokens, passwords, and the
TOTP secret are never written to event metadata or logs.

## API Surface

- `GET /api/settings/mfa`: read the current user's status and remaining code count.
- `POST /api/settings/mfa/setup`: password reauthentication and pending secret.
- `POST /api/settings/mfa/confirm`: confirm TOTP and return recovery codes once.
- `POST /api/settings/mfa/recovery-codes`: replace codes after password plus TOTP.
- `DELETE /api/settings/mfa`: disable after password plus TOTP or recovery code.
- `POST /api/auth/mfa/verify`: consume a login or invitation challenge.

`POST /api/auth/login` and `POST /api/invitations/accept` return HTTP 202 with
`mfaRequired`, `challengeToken`, `expiresAt`, and supported methods when a second
factor is required. No Session is issued and an invitation is not consumed until
`POST /api/auth/mfa/verify` succeeds.

## Role Matrix

Owner, Admin, Developer, Member, Billing, and Viewer can read and manage only
their own MFA factor. MFA routes do not depend on Workspace management
permissions. Workspace API Keys cannot access MFA routes.

## Production Verification

- Confirm NTP or equivalent time synchronization on every API node.
- Confirm `PRIMALTHRUM_SECRET_KEY` is injected from the production secret manager.
- Enroll a test identity, save recovery codes, and verify password login returns
  202 without a Session before MFA succeeds.
- Verify the same TOTP and recovery code each fail on replay.
- Verify five invalid challenge attempts lock that challenge.
- Verify an MFA-enabled existing user cannot consume an invitation before MFA.
- Verify enabling and disabling MFA revoke all other Sessions.
- Alert on elevated `auth_mfa_verify` rate limiting and repeated failed challenge
  events without exporting identity or token values as metric labels.
