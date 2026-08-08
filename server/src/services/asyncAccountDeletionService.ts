import { createHash, randomUUID } from 'node:crypto';

import { type AsyncDatabaseAdapter, type AsyncDatabaseSession } from '../db/asyncAdapter';
import {
  AccountDeletionBlockedError,
} from './accountDeletionService';
import {
  type AccountDeletionState,
  type AccountDeletionStore,
} from './accountDeletionStore';
import {
  type AccountDeletionBlocker,
  type AccountPrivacyRequestRecord,
} from './accountPrivacyRepository';
import { type AccountPrivacyStore } from './accountPrivacyStore';
import { type DocumentFileStorage } from './fileStorage';
import { hashPassword } from './passwordHash';

const DEFAULT_GRACE_PERIOD_MS = 7 * 24 * 60 * 60_000;

export class AsyncAccountDeletionService implements AccountDeletionStore {
  constructor(
    private readonly database: AsyncDatabaseAdapter,
    private readonly privacy: AccountPrivacyStore,
    private readonly storage: DocumentFileStorage,
    private readonly now: () => Date = () => new Date(),
    private readonly gracePeriodMs = DEFAULT_GRACE_PERIOD_MS,
  ) {
    if (!Number.isFinite(gracePeriodMs) || gracePeriodMs < 60_000) {
      throw new Error('account deletion grace period must be at least one minute');
    }
  }

  async state(userId: number): Promise<AccountDeletionState> {
    const [deletion, blockers, requests] = await Promise.all([
      this.privacy.activeDeletion(userId),
      this.privacy.deletionBlockers(userId),
      this.privacy.listForUser(userId),
    ]);
    return {
      deletion,
      blockers,
      gracePeriodDays: Math.ceil(this.gracePeriodMs / (24 * 60 * 60_000)),
      requests,
    };
  }

  async request(userId: number, workspaceId: number): Promise<AccountPrivacyRequestRecord> {
    const blockers = await this.privacy.deletionBlockers(userId);
    if (blockers.length) throw new AccountDeletionBlockedError(blockers);
    const scheduledFor = new Date(this.now().getTime() + this.gracePeriodMs).toISOString();
    return this.privacy.requestDeletion(userId, workspaceId, scheduledFor);
  }

  cancel(userId: number): Promise<AccountPrivacyRequestRecord> {
    return Promise.resolve(this.privacy.cancelDeletion(userId));
  }

  async execute(requestId: string): Promise<Record<string, unknown>> {
    const existing = await this.privacy.findByRequestId(requestId);
    if (!existing || existing.requestType !== 'deletion') {
      throw new Error('account deletion request not found');
    }
    if (['completed', 'cancelled', 'failed'].includes(existing.status)) {
      return { requestId, status: existing.status, skipped: true };
    }
    if (!existing.scheduledFor || new Date(existing.scheduledFor).getTime() > this.now().getTime()) {
      throw new Error('account deletion request is not due');
    }
    const request = await this.privacy.beginDeletion(requestId);
    try {
      const blockers = await this.privacy.deletionBlockers(request.userId);
      if (blockers.length) throw new AccountDeletionBlockedError(blockers);
      const result = await this.eraseAccount(request.userId);
      await this.privacy.completeDeletion(requestId, result);
      return { requestId, status: 'completed', ...result };
    } catch (error) {
      await this.privacy.recordDeletionFailure(requestId, error);
      throw error;
    }
  }

  private async eraseAccount(userId: number): Promise<{
    anonymizedWorkspaces: number;
    deletedDocuments: number;
    revokedApiKeys: number;
  }> {
    const users = await this.database.query<{ email: string; deleted_at: string | Date | null }>({
      text: 'SELECT email, deleted_at FROM users WHERE id = $1 LIMIT 1;',
      values: [userId],
    });
    const user = users[0];
    if (!user) throw new Error('account not found');
    if (user.deleted_at) {
      const counts = await this.database.query<{ count: number | string }>({
        text: `
          SELECT COUNT(*) AS count FROM workspace_memberships membership
          JOIN workspaces workspace ON workspace.id = membership.workspace_id
          WHERE membership.user_id = $1 AND workspace.deleted_at IS NOT NULL;
        `,
        values: [userId],
      });
      return { anonymizedWorkspaces: Number(counts[0]?.count ?? 0), deletedDocuments: 0, revokedApiKeys: 0 };
    }

    const workspaceIds = await this.privacy.ownedSingleMemberWorkspaceIds(userId);
    const membershipRows = await this.database.query<{ workspace_id: number }>({
      text: `SELECT workspace_id FROM workspace_memberships
        WHERE user_id = $1 AND status = 'active' ORDER BY workspace_id;`,
      values: [userId],
    });
    const activeWorkspaceIds = membershipRows.map((row) => Number(row.workspace_id));
    const storageRefs = workspaceIds.length
      ? await this.database.query<{ storage_ref: string }>({
          text: `SELECT storage_ref FROM documents WHERE workspace_id IN (${placeholders(workspaceIds.length)}) AND storage_ref <> '';`,
          values: workspaceIds,
        })
      : [];
    const secretRows = await this.database.query<{ secret_ref: string }>({
      text: 'SELECT secret_ref FROM user_mfa_factors WHERE user_id = $1;',
      values: [userId],
    });
    const now = this.now().toISOString();
    const anonymizedEmail = deletedEmail(userId, user.email);
    const keyCounts = await this.database.query<{ count: number | string }>({
      text: `SELECT COUNT(*) AS count FROM workspace_api_keys
        WHERE created_by_user_id = $1 AND revoked_at IS NULL;`,
      values: [userId],
    });
    await this.database.transaction(async (session) => {
      await this.lock(session, userId, activeWorkspaceIds);
      const blockers = await this.deletionBlockers(session, userId);
      if (blockers.length) throw new AccountDeletionBlockedError(blockers);
      for (const row of storageRefs) await this.storage.delete(row.storage_ref);
      await session.execute({
        text: `UPDATE workspace_api_keys SET revoked_at = COALESCE(revoked_at, $2), updated_at = $2
          WHERE created_by_user_id = $1;`,
        values: [userId, now],
      });
      await session.execute({
        text: `UPDATE sessions SET revoked_at = COALESCE(revoked_at, $2) WHERE user_id = $1;`,
        values: [userId, now],
      });
      await session.execute({ text: 'DELETE FROM account_action_tokens WHERE user_id = $1;', values: [userId] });
      await session.execute({ text: 'DELETE FROM user_mfa_recovery_codes WHERE user_id = $1;', values: [userId] });
      await session.execute({ text: 'DELETE FROM user_mfa_challenges WHERE user_id = $1;', values: [userId] });
      await session.execute({ text: 'DELETE FROM user_mfa_factors WHERE user_id = $1;', values: [userId] });
      if (secretRows.length) {
        await session.execute({
          text: `DELETE FROM secrets WHERE secret_ref IN (${placeholders(secretRows.length)});`,
          values: secretRows.map((row) => row.secret_ref),
        });
      }
      await session.execute({
        text: `
          UPDATE account_email_outbox SET recipient_email = $2, payload_json = '{}',
            status = CASE WHEN status IN ('pending', 'delivering', 'failed')
              THEN 'superseded' ELSE status END, updated_at = $3
          WHERE user_id = $1 OR recipient_email = $4;
        `,
        values: [userId, anonymizedEmail, now, user.email],
      });
      for (const workspaceId of workspaceIds) {
        await this.eraseWorkspace(session, workspaceId, anonymizedEmail, now);
      }
      await session.execute({
        text: `UPDATE workspace_memberships SET status = 'inactive', updated_at = $2 WHERE user_id = $1;`,
        values: [userId, now],
      });
      await session.execute({
        text: `
          UPDATE users SET email = $2, password_hash = $3, role = 'member',
            email_verified_at = NULL, deleted_at = $4, updated_at = $4
          WHERE id = $1 AND deleted_at IS NULL;
        `,
        values: [userId, anonymizedEmail, hashPassword(randomUUID()), now],
      });
    });
    return {
      anonymizedWorkspaces: workspaceIds.length,
      deletedDocuments: storageRefs.length,
      revokedApiKeys: Number(keyCounts[0]?.count ?? 0),
    };
  }

  private async lock(
    session: AsyncDatabaseSession,
    userId: number,
    workspaceIds: number[],
  ): Promise<void> {
    if (this.database.dialect !== 'postgres') return;
    await session.query({ text: 'SELECT id FROM users WHERE id = $1 FOR UPDATE;', values: [userId] });
    if (workspaceIds.length) {
      await session.query({
        text: `SELECT id FROM workspaces WHERE id IN (${placeholders(workspaceIds.length)}) ORDER BY id FOR UPDATE;`,
        values: workspaceIds,
      });
    }
  }

  private async deletionBlockers(
    session: AsyncDatabaseSession,
    userId: number,
  ): Promise<AccountDeletionBlocker[]> {
    const owned = await session.query<{
      workspace_id: number;
      workspace_name: string;
      member_count: number | string;
      plan_price_minor: number | string;
      subscription_state: string;
    }>({
      text: `
        SELECT workspace.id AS workspace_id, workspace.name AS workspace_name,
          (SELECT COUNT(*) FROM workspace_memberships members
            WHERE members.workspace_id = workspace.id AND members.status = 'active') AS member_count,
          COALESCE(plan.monthly_price_minor, 0) AS plan_price_minor,
          COALESCE(subscription.state, '') AS subscription_state
        FROM workspace_memberships membership
        JOIN workspaces workspace ON workspace.id = membership.workspace_id
        LEFT JOIN workspace_subscriptions subscription ON subscription.workspace_id = workspace.id
        LEFT JOIN billing_plans plan ON plan.key = subscription.plan_key
        WHERE membership.user_id = $1 AND membership.role = 'owner'
          AND membership.status = 'active' AND workspace.deleted_at IS NULL
        ORDER BY workspace.id;
      `,
      values: [userId],
    });
    const blockers: AccountDeletionBlocker[] = [];
    for (const row of owned) {
      if (Number(row.member_count) > 1) blockers.push({
        code: 'OWNERSHIP_TRANSFER_REQUIRED',
        workspaceId: Number(row.workspace_id),
        workspaceName: row.workspace_name,
      });
      if (
        Number(row.plan_price_minor) > 0
        && ['trialing', 'active', 'past_due', 'incomplete'].includes(row.subscription_state)
      ) blockers.push({
        code: 'ACTIVE_PAID_SUBSCRIPTION',
        workspaceId: Number(row.workspace_id),
        workspaceName: row.workspace_name,
      });
    }
    const held = await session.query<{ workspace_id: number; workspace_name: string }>({
      text: `
        SELECT DISTINCT workspace.id AS workspace_id, workspace.name AS workspace_name
        FROM workspace_memberships membership
        JOIN workspaces workspace ON workspace.id = membership.workspace_id
        JOIN workspace_legal_holds hold ON hold.workspace_id = workspace.id
        WHERE membership.user_id = $1 AND membership.status = 'active'
          AND workspace.deleted_at IS NULL AND hold.status = 'active'
        ORDER BY workspace.id;
      `,
      values: [userId],
    });
    for (const row of held) blockers.push({
      code: 'LEGAL_HOLD_ACTIVE',
      workspaceId: Number(row.workspace_id),
      workspaceName: row.workspace_name,
    });
    return blockers;
  }

  private async eraseWorkspace(
    session: AsyncDatabaseSession,
    workspaceId: number,
    anonymizedEmail: string,
    now: string,
  ): Promise<void> {
    await session.execute({ text: 'DELETE FROM agents WHERE workspace_id = $1;', values: [workspaceId] });
    await session.execute({ text: 'DELETE FROM provider_configs WHERE workspace_id = $1;', values: [workspaceId] });
    await session.execute({ text: 'DELETE FROM secrets WHERE workspace_id = $1;', values: [workspaceId] });
    await session.execute({ text: 'DELETE FROM workspace_capability_settings WHERE workspace_id = $1;', values: [workspaceId] });
    await session.execute({
      text: `UPDATE workspace_api_keys SET revoked_at = COALESCE(revoked_at, $2), updated_at = $2 WHERE workspace_id = $1;`,
      values: [workspaceId, now],
    });
    await session.execute({
      text: `UPDATE workspace_invitations SET revoked_at = COALESCE(revoked_at, $2)
        WHERE workspace_id = $1 AND accepted_at IS NULL;`,
      values: [workspaceId, now],
    });
    await session.execute({
      text: `UPDATE account_email_outbox SET status = 'superseded', payload_json = '{}', updated_at = $2
        WHERE workspace_id = $1 AND template = 'workspace_invitation'
          AND status IN ('pending', 'delivering', 'failed');`,
      values: [workspaceId, now],
    });
    await session.execute({
      text: 'UPDATE payment_customers SET email = $2, updated_at = $3 WHERE workspace_id = $1;',
      values: [workspaceId, anonymizedEmail, now],
    });
    await session.execute({
      text: `UPDATE workspaces SET name = 'Deleted workspace', slug = $2,
        deleted_at = $3, updated_at = $3 WHERE id = $1;`,
      values: [workspaceId, `deleted-workspace-${workspaceId}-${randomUUID().slice(0, 8)}`, now],
    });
  }
}

function placeholders(count: number): string {
  return Array.from({ length: count }, (_, index) => `$${index + 1}`).join(', ');
}

function deletedEmail(userId: number, email: string): string {
  const digest = createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 16);
  return `deleted+${userId}-${digest}@users.invalid`;
}
