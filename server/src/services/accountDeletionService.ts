import { createHash, randomUUID } from 'node:crypto';

import { type DatabaseAdapter } from '../db/adapter';
import { sqlValue } from '../db/sql';
import {
  AccountPrivacyRepository,
  type AccountDeletionBlocker,
  type AccountPrivacyRequestRecord,
} from './accountPrivacyRepository';
import { type DocumentFileStorage } from './fileStorage';
import { hashPassword } from './passwordHash';
import { type AccountDeletionStore } from './accountDeletionStore';

const DEFAULT_GRACE_PERIOD_MS = 7 * 24 * 60 * 60_000;

export class AccountDeletionBlockedError extends Error {
  constructor(readonly blockers: AccountDeletionBlocker[]) {
    super('account deletion prerequisites are not satisfied');
  }
}

export class AccountDeletionService implements AccountDeletionStore {
  constructor(
    private readonly db: DatabaseAdapter,
    private readonly privacy: AccountPrivacyRepository,
    private readonly storage: DocumentFileStorage,
    private readonly now: () => Date = () => new Date(),
    private readonly gracePeriodMs = DEFAULT_GRACE_PERIOD_MS,
  ) {
    if (!Number.isFinite(gracePeriodMs) || gracePeriodMs < 60_000) {
      throw new Error('account deletion grace period must be at least one minute');
    }
  }

  state(userId: number): {
    deletion: AccountPrivacyRequestRecord | null;
    blockers: AccountDeletionBlocker[];
    gracePeriodDays: number;
    requests: AccountPrivacyRequestRecord[];
  } {
    return {
      deletion: this.privacy.activeDeletion(userId),
      blockers: this.privacy.deletionBlockers(userId),
      gracePeriodDays: Math.ceil(this.gracePeriodMs / (24 * 60 * 60_000)),
      requests: this.privacy.listForUser(userId),
    };
  }

  request(userId: number, workspaceId: number): AccountPrivacyRequestRecord {
    const blockers = this.privacy.deletionBlockers(userId);
    if (blockers.length) throw new AccountDeletionBlockedError(blockers);
    const scheduledFor = new Date(this.now().getTime() + this.gracePeriodMs).toISOString();
    return this.privacy.requestDeletion(userId, workspaceId, scheduledFor);
  }

  cancel(userId: number): AccountPrivacyRequestRecord {
    return this.privacy.cancelDeletion(userId);
  }

  async execute(requestId: string): Promise<Record<string, unknown>> {
    const existing = this.privacy.findByRequestId(requestId);
    if (!existing || existing.requestType !== 'deletion') {
      throw new Error('account deletion request not found');
    }
    if (existing.status === 'completed' || existing.status === 'cancelled' || existing.status === 'failed') {
      return { requestId, status: existing.status, skipped: true };
    }
    if (!existing.scheduledFor || new Date(existing.scheduledFor).getTime() > this.now().getTime()) {
      throw new Error('account deletion request is not due');
    }

    const request = this.privacy.beginDeletion(requestId);
    try {
      const blockers = this.privacy.deletionBlockers(request.userId);
      if (blockers.length) throw new AccountDeletionBlockedError(blockers);
      const result = await this.eraseAccount(request.userId);
      this.privacy.completeDeletion(requestId, result);
      return { requestId, status: 'completed', ...result };
    } catch (error) {
      this.privacy.recordDeletionFailure(requestId, error);
      throw error;
    }
  }

  private async eraseAccount(userId: number): Promise<{
    anonymizedWorkspaces: number;
    deletedDocuments: number;
    revokedApiKeys: number;
  }> {
    const user = this.db.query<{ email: string; deleted_at: string | null }>(`
      SELECT email, deleted_at FROM users WHERE id = ${sqlValue(userId)} LIMIT 1;
    `)[0];
    if (!user) throw new Error('account not found');
    if (user.deleted_at) {
      return {
        anonymizedWorkspaces: Number(this.db.query<{ count: number }>(`
          SELECT COUNT(*) AS count FROM workspace_memberships membership
          JOIN workspaces workspace ON workspace.id = membership.workspace_id
          WHERE membership.user_id = ${sqlValue(userId)} AND workspace.deleted_at IS NOT NULL;
        `)[0]?.count ?? 0),
        deletedDocuments: 0,
        revokedApiKeys: 0,
      };
    }
    const workspaceIds = this.privacy.ownedSingleMemberWorkspaceIds(userId);
    const storageRefs = workspaceIds.length ? this.db.query<{ storage_ref: string }>(`
      SELECT storage_ref FROM documents
      WHERE workspace_id IN (${workspaceIds.map(sqlValue).join(', ')}) AND storage_ref <> '';
    `).map((row) => row.storage_ref) : [];
    const mfaSecretRefs = this.db.query<{ secret_ref: string }>(`
      SELECT secret_ref FROM user_mfa_factors WHERE user_id = ${sqlValue(userId)};
    `).map((row) => row.secret_ref);

    for (const storageRef of storageRefs) await this.storage.delete(storageRef);

    const now = this.now().toISOString();
    const anonymizedEmail = deletedEmail(userId, user.email);
    const revokedApiKeys = Number(this.db.query<{ count: number }>(`
      SELECT COUNT(*) AS count FROM workspace_api_keys
      WHERE created_by_user_id = ${sqlValue(userId)} AND revoked_at IS NULL;
    `)[0]?.count ?? 0);
    const workspaceStatements = workspaceIds.map((workspaceId) => `
      DELETE FROM agents WHERE workspace_id = ${sqlValue(workspaceId)};
      DELETE FROM provider_configs WHERE workspace_id = ${sqlValue(workspaceId)};
      DELETE FROM secrets WHERE workspace_id = ${sqlValue(workspaceId)};
      DELETE FROM workspace_capability_settings WHERE workspace_id = ${sqlValue(workspaceId)};
      UPDATE workspace_api_keys SET revoked_at = COALESCE(revoked_at, ${sqlValue(now)}),
        updated_at = ${sqlValue(now)} WHERE workspace_id = ${sqlValue(workspaceId)};
      UPDATE workspace_invitations SET revoked_at = COALESCE(revoked_at, ${sqlValue(now)})
        WHERE workspace_id = ${sqlValue(workspaceId)} AND accepted_at IS NULL;
      UPDATE account_email_outbox SET status = 'superseded', payload_json = '{}',
        updated_at = ${sqlValue(now)}
        WHERE workspace_id = ${sqlValue(workspaceId)} AND template = 'workspace_invitation'
          AND status IN ('pending', 'delivering', 'failed');
      UPDATE payment_customers SET email = ${sqlValue(anonymizedEmail)}, updated_at = ${sqlValue(now)}
        WHERE workspace_id = ${sqlValue(workspaceId)};
      UPDATE workspaces SET name = 'Deleted workspace',
        slug = ${sqlValue(`deleted-workspace-${workspaceId}-${randomUUID().slice(0, 8)}`)},
        deleted_at = ${sqlValue(now)}, updated_at = ${sqlValue(now)}
        WHERE id = ${sqlValue(workspaceId)};
    `).join('\n');

    this.db.run(`
      PRAGMA foreign_keys = ON;
      BEGIN IMMEDIATE;
      UPDATE workspace_api_keys SET revoked_at = COALESCE(revoked_at, ${sqlValue(now)}),
        updated_at = ${sqlValue(now)}
      WHERE created_by_user_id = ${sqlValue(userId)};
      UPDATE sessions SET revoked_at = COALESCE(revoked_at, ${sqlValue(now)})
      WHERE user_id = ${sqlValue(userId)};
      DELETE FROM account_action_tokens WHERE user_id = ${sqlValue(userId)};
      DELETE FROM user_mfa_recovery_codes WHERE user_id = ${sqlValue(userId)};
      DELETE FROM user_mfa_challenges WHERE user_id = ${sqlValue(userId)};
      DELETE FROM user_mfa_factors WHERE user_id = ${sqlValue(userId)};
      ${mfaSecretRefs.length
        ? `DELETE FROM secrets WHERE secret_ref IN (${mfaSecretRefs.map(sqlValue).join(', ')});`
        : ''}
      UPDATE account_email_outbox
      SET recipient_email = ${sqlValue(anonymizedEmail)}, payload_json = '{}',
        status = CASE WHEN status IN ('pending', 'delivering', 'failed') THEN 'superseded' ELSE status END,
        updated_at = ${sqlValue(now)}
      WHERE user_id = ${sqlValue(userId)} OR recipient_email = ${sqlValue(user.email)};
      ${workspaceStatements}
      UPDATE workspace_memberships SET status = 'inactive', updated_at = ${sqlValue(now)}
      WHERE user_id = ${sqlValue(userId)};
      UPDATE users SET email = ${sqlValue(anonymizedEmail)},
        password_hash = ${sqlValue(hashPassword(randomUUID()))}, role = 'member',
        email_verified_at = NULL, deleted_at = ${sqlValue(now)}, updated_at = ${sqlValue(now)}
      WHERE id = ${sqlValue(userId)} AND deleted_at IS NULL;
      COMMIT;
    `);

    return {
      anonymizedWorkspaces: workspaceIds.length,
      deletedDocuments: storageRefs.length,
      revokedApiKeys,
    };
  }
}

function deletedEmail(userId: number, email: string): string {
  const digest = createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 16);
  return `deleted+${userId}-${digest}@users.invalid`;
}
