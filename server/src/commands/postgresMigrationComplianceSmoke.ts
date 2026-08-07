import { type AsyncDatabaseAdapter } from '../db/asyncAdapter';

export const POSTGRES_COMPLIANCE_TABLES = [
  'account_privacy_events',
  'account_privacy_requests',
  'document_upload_security_events',
  'operator_audit_events',
  'operator_feature_flag_events',
  'operator_feature_flag_overrides',
  'operator_feature_flags',
  'operator_incident_events',
  'operator_incidents',
  'operator_sessions',
  'operator_support_grants',
  'operator_users',
  'workspace_legal_hold_events',
  'workspace_legal_holds',
  'workspace_ownership_events',
] as const;

async function expectDatabaseFailure(operation: () => Promise<unknown>, message: string): Promise<void> {
  try {
    await operation();
  } catch {
    return;
  }
  throw new Error(message);
}

export async function verifyComplianceMigrations(
  database: AsyncDatabaseAdapter,
  userId: number,
  legacyAgentId: number,
): Promise<void> {
  await database.execute({
    text: `
      INSERT INTO account_email_outbox (
        workspace_id, invitation_id, template, recipient_email, payload_json
      ) VALUES ($1, $2, $3, $4, $5);
    `,
    values: [1, 7001, 'workspace_invitation', 'invite-migration@example.com', '{}'],
  });
  await expectDatabaseFailure(
    () => database.execute({
      text: `
        INSERT INTO account_email_outbox (template, recipient_email, payload_json)
        VALUES ($1, $2, $3);
      `,
      values: ['workspace_invitation', 'invalid-migration@example.com', '{}'],
    }),
    'workspace invitation email target constraint was not enforced',
  );

  const operators = await database.query<{ id: number }>({
    text: `
      INSERT INTO operator_users (email, password_hash, role, bootstrap_root)
      VALUES
        ('root-migration@example.com', 'hash', 'super_admin', TRUE),
        ('security-migration@example.com', 'hash', 'security', FALSE)
      RETURNING id;
    `,
  });
  const rootOperatorId = operators[0]!.id;
  const securityOperatorId = operators[1]!.id;
  const audit = await database.query<{ id: number }>({
    text: `
      INSERT INTO operator_audit_events (event_id, operator_user_id, event_type)
      VALUES ($1, $2, $3)
      RETURNING id;
    `,
    values: ['operator-audit-migration', rootOperatorId, 'bootstrap'],
  });
  await expectDatabaseFailure(
    () => database.execute({
      text: 'UPDATE operator_audit_events SET event_type = $1 WHERE id = $2;',
      values: ['changed', audit[0]!.id],
    }),
    'operator audit event update was not rejected',
  );

  const grants = await database.query<{ id: number }>({
    text: `
      INSERT INTO operator_support_grants (
        workspace_id, operator_user_id, permissions_json, reason,
        ticket_ref, expires_at, created_by_operator_id
      ) VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP + INTERVAL '1 hour', $6)
      RETURNING id;
    `,
    values: [1, securityOperatorId, '["workspace:read"]', 'Migration smoke', 'TICKET-1', rootOperatorId],
  });
  await database.execute({
    text: `
      UPDATE operator_support_grants
      SET revoked_at = CURRENT_TIMESTAMP, revoked_by_operator_id = $1
      WHERE id = $2;
    `,
    values: [rootOperatorId, grants[0]!.id],
  });
  await expectDatabaseFailure(
    () => database.execute({
      text: 'DELETE FROM operator_support_grants WHERE id = $1;',
      values: [grants[0]!.id],
    }),
    'operator support grant deletion was not rejected',
  );

  const flags = await database.query<{ id: number }>({
    text: `
      INSERT INTO operator_feature_flags (
        key, description, created_by_operator_id, updated_by_operator_id
      ) VALUES ($1, $2, $3, $3)
      RETURNING id;
    `,
    values: ['migration.flag', 'Migration smoke', rootOperatorId],
  });
  await expectDatabaseFailure(
    () => database.execute({
      text: 'UPDATE operator_feature_flags SET enabled = TRUE WHERE id = $1;',
      values: [flags[0]!.id],
    }),
    'feature flag update without revision was not rejected',
  );
  await database.execute({
    text: `
      UPDATE operator_feature_flags
      SET enabled = TRUE, revision = revision + 1, updated_by_operator_id = $1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $2;
    `,
    values: [rootOperatorId, flags[0]!.id],
  });

  const upload = await database.query<{ id: number }>({
    text: `
      INSERT INTO document_upload_security_events (
        event_id, workspace_id, agent_id, user_id, filename_hash,
        content_sha256, mime_type, size_bytes, scanner, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id;
    `,
    values: [
      'upload-security-migration', 1, legacyAgentId, userId, 'a'.repeat(64),
      'b'.repeat(64), 'text/plain', 10, 'smoke', 'clean',
    ],
  });
  await expectDatabaseFailure(
    () => database.execute({
      text: 'DELETE FROM document_upload_security_events WHERE id = $1;',
      values: [upload[0]!.id],
    }),
    'upload security evidence deletion was not rejected',
  );

  await database.execute({
    text: `
      INSERT INTO account_privacy_requests (
        request_id, user_id, workspace_id, request_type, scope, status, completed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP);
    `,
    values: ['privacy-request-migration', userId, 1, 'export', 'account', 'completed'],
  });
  await database.execute({
    text: `
      INSERT INTO account_privacy_events (event_id, request_id, subject_hash, event_type)
      VALUES ($1, $2, $3, $4);
    `,
    values: ['privacy-event-migration', 'privacy-request-migration', 'c'.repeat(64), 'export_completed'],
  });
  await expectDatabaseFailure(
    () => database.execute({
      text: 'UPDATE account_privacy_events SET metadata_json = $1 WHERE event_id = $2;',
      values: ['{"changed":true}', 'privacy-event-migration'],
    }),
    'account privacy event update was not rejected',
  );

  const newUsers = await database.query<{ id: number }>({
    text: `
      INSERT INTO users (workspace_id, email, password_hash, role, email_verified_at)
      VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
      RETURNING id;
    `,
    values: [1, 'new-owner-migration@example.com', 'hash', 'user'],
  });
  const newOwnerId = newUsers[0]!.id;
  const ownership = await database.query<{ id: number }>({
    text: `
      INSERT INTO workspace_ownership_events (
        event_id, workspace_id, previous_owner_user_id, new_owner_user_id, initiated_by_user_id
      ) VALUES ($1, $2, $3, $4, $3)
      RETURNING id;
    `,
    values: ['ownership-migration', 1, userId, newOwnerId],
  });
  await expectDatabaseFailure(
    () => database.execute({
      text: 'DELETE FROM workspace_ownership_events WHERE id = $1;',
      values: [ownership[0]!.id],
    }),
    'workspace ownership evidence deletion was not rejected',
  );

  const holds = await database.query<{ id: number }>({
    text: `
      INSERT INTO workspace_legal_holds (
        hold_ref, workspace_id, external_case_ref, basis, reason, created_by_operator_id
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id;
    `,
    values: ['hold-migration', 1, 'case-migration', 'litigation', 'Migration smoke', rootOperatorId],
  });
  await expectDatabaseFailure(
    () => database.execute({
      text: `
        UPDATE workspace_legal_holds
        SET status = 'released', revision = 2, released_by_operator_id = $1,
            release_reason = 'invalid self release', released_at = CURRENT_TIMESTAMP
        WHERE id = $2;
      `,
      values: [rootOperatorId, holds[0]!.id],
    }),
    'legal hold self-release was not rejected',
  );
  await database.execute({
    text: `
      UPDATE workspace_legal_holds
      SET status = 'released', revision = 2, released_by_operator_id = $1,
          release_reason = 'Second operator approval', released_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $2;
    `,
    values: [securityOperatorId, holds[0]!.id],
  });
  await database.execute({
    text: `
      INSERT INTO workspace_legal_hold_events (
        event_id, legal_hold_id, operator_user_id, action, revision
      ) VALUES ($1, $2, $3, $4, $5);
    `,
    values: ['legal-hold-event-migration', holds[0]!.id, securityOperatorId, 'released', 2],
  });
  await database.execute({
    text: `
      INSERT INTO retention_events (workspace_id, event_type, policy_json, result_json)
      VALUES ($1, $2, $3, $4);
    `,
    values: [1, 'enforcement_blocked', '{}', '{"holdRef":"hold-migration"}'],
  });
  await expectDatabaseFailure(
    () => database.execute({
      text: 'DELETE FROM workspace_legal_holds WHERE id = $1;',
      values: [holds[0]!.id],
    }),
    'released legal hold deletion was not rejected',
  );
}
