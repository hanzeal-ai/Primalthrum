import { type AsyncDatabaseAdapter } from '../db/asyncAdapter';

export const POSTGRES_SECURITY_TABLES = [
  'abuse_challenge_grants',
  'abuse_enforcement_events',
  'abuse_rate_limit_buckets',
  'account_action_tokens',
  'account_email_delivery_events',
  'account_email_outbox',
  'api_key_usage_events',
  'privacy_consent_receipts',
  'product_analytics_events',
  'retained_tool_audit_logs',
  'retention_events',
  'retention_file_deletions',
  'user_mfa_challenges',
  'user_mfa_events',
  'user_mfa_factors',
  'user_mfa_recovery_codes',
  'workspace_api_keys',
  'workspace_onboarding',
  'workspace_retention_policies',
] as const;

async function expectDatabaseFailure(operation: () => Promise<unknown>, message: string): Promise<void> {
  try {
    await operation();
  } catch {
    return;
  }
  throw new Error(message);
}

export async function verifySecurityMigrations(
  database: AsyncDatabaseAdapter,
  userId: number,
): Promise<void> {
  const identity = await database.query<{
    email_verified: boolean;
    session_seen: boolean;
    authentication_method: string;
  }>({
    text: `
      SELECT
        users.email_verified_at IS NOT NULL AS email_verified,
        sessions.last_seen_at IS NOT NULL AS session_seen,
        sessions.authentication_method
      FROM users
      JOIN sessions ON sessions.user_id = users.id
      WHERE users.id = $1;
    `,
    values: [userId],
  });
  if (identity[0]?.email_verified !== true || identity[0]?.session_seen !== true
    || identity[0]?.authentication_method !== 'password') {
    throw new Error('account security columns were not backfilled');
  }

  const receipts = await database.query<{ id: number }>({
    text: `
      INSERT INTO privacy_consent_receipts (
        receipt_id, subject_hash, policy_version, analytics_granted, action, source
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id;
    `,
    values: ['receipt-migration-smoke', 'subject-hash', '2026-08', true, 'granted', 'preferences'],
  });
  await expectDatabaseFailure(
    () => database.execute({
      text: 'UPDATE privacy_consent_receipts SET analytics_granted = FALSE WHERE id = $1;',
      values: [receipts[0]!.id],
    }),
    'privacy consent receipt update was not rejected',
  );

  const outbox = await database.query<{ id: number }>({
    text: `
      INSERT INTO account_email_outbox (
        user_id, template, recipient_email, payload_json, provider, provider_message_id
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id;
    `,
    values: [
      userId,
      'verify_email',
      'migration-smoke@example.com',
      '{}',
      'smoke',
      'message-migration-smoke',
    ],
  });
  const delivery = await database.query<{ id: number }>({
    text: `
      INSERT INTO account_email_delivery_events (
        provider, provider_event_id, provider_message_id, outbox_id, event_type, occurred_at
      ) VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
      RETURNING id;
    `,
    values: ['smoke', 'delivery-migration-smoke', 'message-migration-smoke', outbox[0]!.id, 'accepted'],
  });
  await expectDatabaseFailure(
    () => database.execute({
      text: 'DELETE FROM account_email_delivery_events WHERE id = $1;',
      values: [delivery[0]!.id],
    }),
    'email delivery evidence deletion was not rejected',
  );

  const abuse = await database.query<{ id: number }>({
    text: `
      INSERT INTO abuse_enforcement_events (
        event_id, rule_key, action, subject_hash, outcome
      ) VALUES ($1, $2, $3, $4, $5)
      RETURNING id;
    `,
    values: ['abuse-migration-smoke', 'registration', 'block', 'subject-hash', 'rate_limited'],
  });
  await expectDatabaseFailure(
    () => database.execute({
      text: 'UPDATE abuse_enforcement_events SET action = $1 WHERE id = $2;',
      values: ['allow', abuse[0]!.id],
    }),
    'abuse evidence update was not rejected',
  );

  const keys = await database.query<{ id: number }>({
    text: `
      INSERT INTO workspace_api_keys (
        workspace_id, name, key_prefix, token_hash, scopes_json,
        created_by_user_id, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP + INTERVAL '1 day')
      RETURNING id;
    `,
    values: [1, 'Migration key', 'pk_migration', 'api-key-hash', '["runs:create"]', userId],
  });
  const usage = await database.query<{ id: number }>({
    text: `
      INSERT INTO api_key_usage_events (api_key_id, workspace_id, method, path, used_at)
      VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
      RETURNING id;
    `,
    values: [keys[0]!.id, 1, 'POST', '/api/stream'],
  });
  await expectDatabaseFailure(
    () => database.execute({
      text: 'DELETE FROM api_key_usage_events WHERE id = $1;',
      values: [usage[0]!.id],
    }),
    'API key usage evidence deletion was not rejected',
  );

  const retention = await database.query<{ id: number }>({
    text: `
      INSERT INTO retention_events (workspace_id, event_type, actor_user_id, policy_json)
      VALUES ($1, $2, $3, $4)
      RETURNING id;
    `,
    values: [1, 'policy_updated', userId, '{"runDays":30}'],
  });
  await expectDatabaseFailure(
    () => database.execute({
      text: 'UPDATE retention_events SET policy_json = $1 WHERE id = $2;',
      values: ['{}', retention[0]!.id],
    }),
    'retention evidence update was not rejected',
  );

  const mfa = await database.query<{ id: number }>({
    text: `
      INSERT INTO user_mfa_events (user_id, event_type)
      VALUES ($1, $2)
      RETURNING id;
    `,
    values: [userId, 'setup_started'],
  });
  await expectDatabaseFailure(
    () => database.execute({
      text: 'DELETE FROM user_mfa_events WHERE id = $1;',
      values: [mfa[0]!.id],
    }),
    'MFA evidence deletion was not rejected',
  );
}
