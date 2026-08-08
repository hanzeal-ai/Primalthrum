import { createHash, randomUUID } from 'node:crypto';

import { type AsyncDatabaseAdapter, type AsyncDatabaseSession } from '../db/asyncAdapter';
import { databaseTimestamp, nullableDatabaseTimestamp } from '../db/databaseTimestamp';
import {
  type AccountDeletionBlocker,
  type AccountPrivacyRequestRecord,
  type AccountPrivacyRequestType,
  type AccountPrivacyScope,
  type AccountPrivacyStatus,
} from './accountPrivacyRepository';
import { type AccountPrivacyStore } from './accountPrivacyStore';

interface PrivacyRequestRow {
  id: number;
  request_id: string;
  user_id: number;
  workspace_id: number | null;
  request_type: AccountPrivacyRequestType;
  scope: AccountPrivacyScope;
  status: AccountPrivacyStatus;
  attempts: number;
  scheduled_for: string | Date | null;
  completed_at: string | Date | null;
  cancelled_at: string | Date | null;
  failure_reason: string;
  created_at: string | Date;
  updated_at: string | Date;
}

interface OwnedWorkspaceRow {
  workspace_id: number;
  workspace_name: string;
  member_count: number | string;
  plan_price_minor: number | string;
  subscription_state: string;
}

const MAX_DELETION_ATTEMPTS = 3;

export class AsyncAccountPrivacyRepository implements AccountPrivacyStore {
  constructor(
    private readonly database: AsyncDatabaseAdapter,
    private readonly now: () => Date = () => new Date(),
  ) {}

  recordExport(
    userId: number,
    scope: AccountPrivacyScope,
    workspaceId: number | null,
  ): Promise<AccountPrivacyRequestRecord> {
    const requestId = randomUUID();
    const now = this.now().toISOString();
    return this.database.transaction(async (session) => {
      await session.execute({
        text: `
          INSERT INTO account_privacy_requests (
            request_id, user_id, workspace_id, request_type, scope,
            status, completed_at, created_at, updated_at
          ) VALUES ($1, $2, $3, 'export', $4, 'completed', $5, $5, $5);
        `,
        values: [requestId, userId, workspaceId, scope, now],
      });
      await this.recordEvent(session, requestId, userId, 'export_completed', {
        scope,
        workspaceId,
      }, now);
      return this.require(session, requestId);
    });
  }

  requestDeletion(
    userId: number,
    workspaceId: number,
    scheduledFor: string,
  ): Promise<AccountPrivacyRequestRecord> {
    return this.database.transaction(async (session) => {
      await this.lockUser(session, userId);
      const existing = await this.activeDeletionIn(session, userId);
      if (existing) return existing;
      const requestId = randomUUID();
      const now = this.now().toISOString();
      await session.execute({
        text: `
          INSERT INTO account_privacy_requests (
            request_id, user_id, workspace_id, request_type, scope,
            status, scheduled_for, created_at, updated_at
          ) VALUES ($1, $2, $3, 'deletion', 'account', 'scheduled', $4, $5, $5);
        `,
        values: [requestId, userId, workspaceId, scheduledFor, now],
      });
      await this.recordEvent(session, requestId, userId, 'deletion_scheduled', {
        scheduledFor,
      }, now);
      return this.require(session, requestId);
    });
  }

  cancelDeletion(userId: number): Promise<AccountPrivacyRequestRecord> {
    return this.database.transaction(async (session) => {
      await this.lockUser(session, userId);
      const request = await this.activeDeletionIn(session, userId);
      if (!request || request.status !== 'scheduled') {
        throw new Error('no cancellable account deletion request exists');
      }
      const now = this.now().toISOString();
      const result = await session.execute({
        text: `
          UPDATE account_privacy_requests
          SET status = 'cancelled', cancelled_at = $2, updated_at = $2
          WHERE request_id = $1 AND status = 'scheduled';
        `,
        values: [request.requestId, now],
      });
      if (result.rowCount !== 1) throw new Error('account deletion cancellation conflicted');
      await this.recordEvent(session, request.requestId, userId, 'deletion_cancelled', {}, now);
      return this.require(session, request.requestId);
    });
  }

  beginDeletion(requestId: string): Promise<AccountPrivacyRequestRecord> {
    return this.database.transaction(async (session) => {
      const request = await this.require(session, requestId, true);
      if (request.status !== 'scheduled') return request;
      const now = this.now().toISOString();
      const result = await session.execute({
        text: `
          UPDATE account_privacy_requests
          SET status = 'processing', failure_reason = '', updated_at = $2
          WHERE request_id = $1 AND status = 'scheduled';
        `,
        values: [requestId, now],
      });
      if (result.rowCount !== 1) return this.require(session, requestId);
      await this.recordEvent(session, requestId, request.userId, 'deletion_started', {
        attempt: request.attempts + 1,
      }, now);
      return this.require(session, requestId);
    });
  }

  completeDeletion(
    requestId: string,
    metadata: Record<string, unknown>,
  ): Promise<AccountPrivacyRequestRecord> {
    return this.database.transaction(async (session) => {
      const request = await this.require(session, requestId, true);
      const now = this.now().toISOString();
      const result = await session.execute({
        text: `
          UPDATE account_privacy_requests
          SET status = 'completed', completed_at = $2, updated_at = $2
          WHERE request_id = $1 AND status = 'processing';
        `,
        values: [requestId, now],
      });
      if (result.rowCount !== 1) throw new Error('account deletion completion conflicted');
      await this.recordEvent(session, requestId, request.userId, 'deletion_completed', metadata, now);
      return this.require(session, requestId);
    });
  }

  recordDeletionFailure(requestId: string, error: unknown): Promise<AccountPrivacyRequestRecord> {
    return this.database.transaction(async (session) => {
      const request = await this.require(session, requestId, true);
      const attempts = request.attempts + 1;
      const status: AccountPrivacyStatus = attempts >= MAX_DELETION_ATTEMPTS ? 'failed' : 'scheduled';
      const now = this.now().toISOString();
      const result = await session.execute({
        text: `
          UPDATE account_privacy_requests
          SET status = $2, attempts = $3, failure_reason = $4, updated_at = $5
          WHERE request_id = $1 AND status = 'processing';
        `,
        values: [requestId, status, attempts, boundedFailure(error), now],
      });
      if (result.rowCount !== 1) throw new Error('account deletion failure update conflicted');
      await this.recordEvent(session, requestId, request.userId, 'deletion_failed', {
        attempt: attempts,
        terminal: status === 'failed',
      }, now);
      return this.require(session, requestId);
    });
  }

  activeDeletion(userId: number): Promise<AccountPrivacyRequestRecord | null> {
    return this.activeDeletionIn(this.database, userId);
  }

  async findByRequestId(requestId: string): Promise<AccountPrivacyRequestRecord | null> {
    const rows = await this.database.query<PrivacyRequestRow>({
      text: `SELECT ${REQUEST_COLUMNS} FROM account_privacy_requests WHERE request_id = $1 LIMIT 1;`,
      values: [requestId],
    });
    return rows[0] ? toPrivacyRequest(rows[0]) : null;
  }

  async listForUser(userId: number, limit = 20): Promise<AccountPrivacyRequestRecord[]> {
    const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 100);
    const rows = await this.database.query<PrivacyRequestRow>({
      text: `
        SELECT ${REQUEST_COLUMNS} FROM account_privacy_requests
        WHERE user_id = $1 ORDER BY id DESC LIMIT $2;
      `,
      values: [userId, boundedLimit],
    });
    return rows.map(toPrivacyRequest);
  }

  async dueDeletions(): Promise<AccountPrivacyRequestRecord[]> {
    const due = this.database.dialect === 'postgres'
      ? 'scheduled_for <= $1'
      : 'datetime(scheduled_for) <= datetime($1)';
    const rows = await this.database.query<PrivacyRequestRow>({
      text: `
        SELECT ${REQUEST_COLUMNS} FROM account_privacy_requests
        WHERE request_type = 'deletion' AND status = 'scheduled'
          AND attempts < ${MAX_DELETION_ATTEMPTS} AND ${due}
        ORDER BY id ASC LIMIT 100;
      `,
      values: [this.now().toISOString()],
    });
    return rows.map(toPrivacyRequest);
  }

  async deletionBlockers(userId: number): Promise<AccountDeletionBlocker[]> {
    const rows = await this.database.query<OwnedWorkspaceRow>({
      text: `
        SELECT w.id AS workspace_id, w.name AS workspace_name,
          (SELECT COUNT(*) FROM workspace_memberships members
            WHERE members.workspace_id = w.id AND members.status = 'active') AS member_count,
          COALESCE(plan.monthly_price_minor, 0) AS plan_price_minor,
          COALESCE(subscription.state, '') AS subscription_state
        FROM workspace_memberships membership
        JOIN workspaces w ON w.id = membership.workspace_id
        LEFT JOIN workspace_subscriptions subscription ON subscription.workspace_id = w.id
        LEFT JOIN billing_plans plan ON plan.key = subscription.plan_key
        WHERE membership.user_id = $1 AND membership.role = 'owner'
          AND membership.status = 'active' AND w.deleted_at IS NULL
        ORDER BY w.id ASC;
      `,
      values: [userId],
    });
    const blockers: AccountDeletionBlocker[] = [];
    for (const row of rows) {
      if (Number(row.member_count) > 1) blockers.push(blocker('OWNERSHIP_TRANSFER_REQUIRED', row));
      if (
        Number(row.plan_price_minor) > 0
        && ['trialing', 'active', 'past_due', 'incomplete'].includes(row.subscription_state)
      ) blockers.push(blocker('ACTIVE_PAID_SUBSCRIPTION', row));
    }
    const holds = await this.database.query<{ workspace_id: number; workspace_name: string }>({
      text: `
        SELECT DISTINCT workspace.id AS workspace_id, workspace.name AS workspace_name
        FROM workspace_memberships membership
        JOIN workspaces workspace ON workspace.id = membership.workspace_id
        JOIN workspace_legal_holds hold ON hold.workspace_id = workspace.id
        WHERE membership.user_id = $1 AND membership.status = 'active'
          AND workspace.deleted_at IS NULL AND hold.status = 'active'
        ORDER BY workspace.id ASC;
      `,
      values: [userId],
    });
    for (const row of holds) blockers.push(blocker('LEGAL_HOLD_ACTIVE', row));
    return blockers;
  }

  async ownedSingleMemberWorkspaceIds(userId: number): Promise<number[]> {
    const rows = await this.database.query<{ workspace_id: number }>({
      text: `
        SELECT membership.workspace_id FROM workspace_memberships membership
        WHERE membership.user_id = $1 AND membership.role = 'owner'
          AND membership.status = 'active'
          AND 1 = (SELECT COUNT(*) FROM workspace_memberships members
            WHERE members.workspace_id = membership.workspace_id AND members.status = 'active')
        ORDER BY membership.workspace_id ASC;
      `,
      values: [userId],
    });
    return rows.map((row) => Number(row.workspace_id));
  }

  private async lockUser(session: AsyncDatabaseSession, userId: number): Promise<void> {
    if (this.database.dialect !== 'postgres') return;
    await session.query({ text: 'SELECT id FROM users WHERE id = $1 FOR UPDATE;', values: [userId] });
  }

  private async activeDeletionIn(
    session: AsyncDatabaseSession,
    userId: number,
  ): Promise<AccountPrivacyRequestRecord | null> {
    const rows = await session.query<PrivacyRequestRow>({
      text: `
        SELECT ${REQUEST_COLUMNS} FROM account_privacy_requests
        WHERE user_id = $1 AND request_type = 'deletion'
          AND status IN ('scheduled', 'processing') ORDER BY id DESC LIMIT 1;
      `,
      values: [userId],
    });
    return rows[0] ? toPrivacyRequest(rows[0]) : null;
  }

  private async require(
    session: AsyncDatabaseSession,
    requestId: string,
    lock = false,
  ): Promise<AccountPrivacyRequestRecord> {
    const rows = await session.query<PrivacyRequestRow>({
      text: `
        SELECT ${REQUEST_COLUMNS} FROM account_privacy_requests
        WHERE request_id = $1 LIMIT 1
        ${lock && this.database.dialect === 'postgres' ? 'FOR UPDATE' : ''};
      `,
      values: [requestId],
    });
    if (!rows[0]) throw new Error('account privacy request not found');
    return toPrivacyRequest(rows[0]);
  }

  private async recordEvent(
    session: AsyncDatabaseSession,
    requestId: string,
    userId: number,
    eventType: string,
    metadata: Record<string, unknown>,
    createdAt: string,
  ): Promise<void> {
    await session.execute({
      text: `
        INSERT INTO account_privacy_events (
          event_id, request_id, subject_hash, event_type, metadata_json, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6);
      `,
      values: [
        randomUUID(), requestId, subjectHash(userId), eventType,
        JSON.stringify(metadata), createdAt,
      ],
    });
  }
}

function subjectHash(userId: number): string {
  return createHash('sha256').update(`primalthrum-account:${userId}`).digest('hex');
}

function boundedFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : 'account deletion failed';
  return message.replace(/[\r\n]+/g, ' ').slice(0, 256);
}

function blocker(
  code: AccountDeletionBlocker['code'],
  row: { workspace_id: number; workspace_name: string },
): AccountDeletionBlocker {
  return { code, workspaceId: Number(row.workspace_id), workspaceName: row.workspace_name };
}

function toPrivacyRequest(row: PrivacyRequestRow): AccountPrivacyRequestRecord {
  return {
    id: Number(row.id), requestId: row.request_id, userId: Number(row.user_id),
    workspaceId: row.workspace_id === null ? null : Number(row.workspace_id),
    requestType: row.request_type, scope: row.scope, status: row.status,
    attempts: Number(row.attempts), scheduledFor: nullableDatabaseTimestamp(row.scheduled_for),
    completedAt: nullableDatabaseTimestamp(row.completed_at),
    cancelledAt: nullableDatabaseTimestamp(row.cancelled_at), failureReason: row.failure_reason,
    createdAt: databaseTimestamp(row.created_at), updatedAt: databaseTimestamp(row.updated_at),
  };
}

const REQUEST_COLUMNS = [
  'id', 'request_id', 'user_id', 'workspace_id', 'request_type', 'scope', 'status',
  'attempts', 'scheduled_for', 'completed_at', 'cancelled_at', 'failure_reason',
  'created_at', 'updated_at',
].join(', ');
