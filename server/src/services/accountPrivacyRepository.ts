import { createHash, randomUUID } from 'node:crypto';

import { type DatabaseAdapter } from '../db/adapter';
import { sqlValue } from '../db/sql';
import { type AccountPrivacyStore } from './accountPrivacyStore';

export type AccountPrivacyRequestType = 'export' | 'deletion';
export type AccountPrivacyScope = 'account' | 'workspace';
export type AccountPrivacyStatus = 'completed' | 'scheduled' | 'processing' | 'cancelled' | 'failed';

export interface AccountPrivacyRequestRecord {
  id: number;
  requestId: string;
  userId: number;
  workspaceId: number | null;
  requestType: AccountPrivacyRequestType;
  scope: AccountPrivacyScope;
  status: AccountPrivacyStatus;
  attempts: number;
  scheduledFor: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  failureReason: string;
  createdAt: string;
  updatedAt: string;
}

export interface AccountDeletionBlocker {
  code: 'OWNERSHIP_TRANSFER_REQUIRED' | 'ACTIVE_PAID_SUBSCRIPTION' | 'LEGAL_HOLD_ACTIVE';
  workspaceId: number;
  workspaceName: string;
}

interface PrivacyRequestRow {
  id: number;
  request_id: string;
  user_id: number;
  workspace_id: number | null;
  request_type: AccountPrivacyRequestType;
  scope: AccountPrivacyScope;
  status: AccountPrivacyStatus;
  attempts: number;
  scheduled_for: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  failure_reason: string;
  created_at: string;
  updated_at: string;
}

interface OwnedWorkspaceRow {
  workspace_id: number;
  workspace_name: string;
  member_count: number;
  plan_price_minor: number;
  subscription_state: string;
}

interface HeldWorkspaceRow {
  workspace_id: number;
  workspace_name: string;
}

const MAX_DELETION_ATTEMPTS = 3;

export class AccountPrivacyRepository implements AccountPrivacyStore {
  constructor(
    private readonly db: DatabaseAdapter,
    private readonly now: () => Date = () => new Date(),
  ) {
  }

  recordExport(userId: number, scope: AccountPrivacyScope, workspaceId: number | null): AccountPrivacyRequestRecord {
    const requestId = randomUUID();
    const now = this.now().toISOString();
    this.db.run(`
      BEGIN IMMEDIATE;
      INSERT INTO account_privacy_requests (
        request_id, user_id, workspace_id, request_type, scope,
        status, completed_at, created_at, updated_at
      ) VALUES (
        ${sqlValue(requestId)}, ${sqlValue(userId)}, ${sqlValue(workspaceId)},
        'export', ${sqlValue(scope)}, 'completed', ${sqlValue(now)},
        ${sqlValue(now)}, ${sqlValue(now)}
      );
      ${privacyEventSql({
        requestId,
        userId,
        eventType: 'export_completed',
        metadata: { scope, workspaceId },
        createdAt: now,
      })}
      COMMIT;
    `);
    return this.requireByRequestId(requestId);
  }

  requestDeletion(userId: number, workspaceId: number, scheduledFor: string): AccountPrivacyRequestRecord {
    const existing = this.activeDeletion(userId);
    if (existing) return existing;
    const requestId = randomUUID();
    const now = this.now().toISOString();
    this.db.run(`
      BEGIN IMMEDIATE;
      INSERT INTO account_privacy_requests (
        request_id, user_id, workspace_id, request_type, scope,
        status, scheduled_for, created_at, updated_at
      ) VALUES (
        ${sqlValue(requestId)}, ${sqlValue(userId)}, ${sqlValue(workspaceId)},
        'deletion', 'account', 'scheduled', ${sqlValue(scheduledFor)},
        ${sqlValue(now)}, ${sqlValue(now)}
      );
      ${privacyEventSql({
        requestId,
        userId,
        eventType: 'deletion_scheduled',
        metadata: { scheduledFor },
        createdAt: now,
      })}
      COMMIT;
    `);
    return this.requireByRequestId(requestId);
  }

  cancelDeletion(userId: number): AccountPrivacyRequestRecord {
    const request = this.activeDeletion(userId);
    if (!request || request.status !== 'scheduled') {
      throw new Error('no cancellable account deletion request exists');
    }
    const now = this.now().toISOString();
    this.db.run(`
      BEGIN IMMEDIATE;
      UPDATE account_privacy_requests
      SET status = 'cancelled', cancelled_at = ${sqlValue(now)}, updated_at = ${sqlValue(now)}
      WHERE request_id = ${sqlValue(request.requestId)} AND status = 'scheduled';
      ${privacyEventSql({
        requestId: request.requestId,
        userId,
        eventType: 'deletion_cancelled',
        metadata: {},
        createdAt: now,
      })}
      COMMIT;
    `);
    return this.requireByRequestId(request.requestId);
  }

  beginDeletion(requestId: string): AccountPrivacyRequestRecord {
    const request = this.requireByRequestId(requestId);
    if (request.status !== 'scheduled') return request;
    const now = this.now().toISOString();
    this.db.run(`
      BEGIN IMMEDIATE;
      UPDATE account_privacy_requests
      SET status = 'processing', failure_reason = '', updated_at = ${sqlValue(now)}
      WHERE request_id = ${sqlValue(requestId)} AND status = 'scheduled';
      ${privacyEventSql({
        requestId,
        userId: request.userId,
        eventType: 'deletion_started',
        metadata: { attempt: request.attempts + 1 },
        createdAt: now,
      })}
      COMMIT;
    `);
    return this.requireByRequestId(requestId);
  }

  completeDeletion(requestId: string, metadata: Record<string, unknown>): AccountPrivacyRequestRecord {
    const request = this.requireByRequestId(requestId);
    const now = this.now().toISOString();
    this.db.run(`
      BEGIN IMMEDIATE;
      UPDATE account_privacy_requests
      SET status = 'completed', completed_at = ${sqlValue(now)}, updated_at = ${sqlValue(now)}
      WHERE request_id = ${sqlValue(requestId)} AND status = 'processing';
      ${privacyEventSql({
        requestId,
        userId: request.userId,
        eventType: 'deletion_completed',
        metadata,
        createdAt: now,
      })}
      COMMIT;
    `);
    return this.requireByRequestId(requestId);
  }

  recordDeletionFailure(requestId: string, error: unknown): AccountPrivacyRequestRecord {
    const request = this.requireByRequestId(requestId);
    const attempts = request.attempts + 1;
    const status: AccountPrivacyStatus = attempts >= MAX_DELETION_ATTEMPTS ? 'failed' : 'scheduled';
    const reason = boundedFailure(error);
    const now = this.now().toISOString();
    this.db.run(`
      BEGIN IMMEDIATE;
      UPDATE account_privacy_requests
      SET status = ${sqlValue(status)}, attempts = ${sqlValue(attempts)},
        failure_reason = ${sqlValue(reason)}, updated_at = ${sqlValue(now)}
      WHERE request_id = ${sqlValue(requestId)} AND status = 'processing';
      ${privacyEventSql({
        requestId,
        userId: request.userId,
        eventType: 'deletion_failed',
        metadata: { attempt: attempts, terminal: status === 'failed' },
        createdAt: now,
      })}
      COMMIT;
    `);
    return this.requireByRequestId(requestId);
  }

  activeDeletion(userId: number): AccountPrivacyRequestRecord | null {
    const row = this.db.query<PrivacyRequestRow>(`
      SELECT ${REQUEST_COLUMNS} FROM account_privacy_requests
      WHERE user_id = ${sqlValue(userId)} AND request_type = 'deletion'
        AND status IN ('scheduled', 'processing')
      ORDER BY id DESC LIMIT 1;
    `)[0];
    return row ? toPrivacyRequest(row) : null;
  }

  findByRequestId(requestId: string): AccountPrivacyRequestRecord | null {
    const row = this.db.query<PrivacyRequestRow>(`
      SELECT ${REQUEST_COLUMNS} FROM account_privacy_requests
      WHERE request_id = ${sqlValue(requestId)} LIMIT 1;
    `)[0];
    return row ? toPrivacyRequest(row) : null;
  }

  listForUser(userId: number, limit = 20): AccountPrivacyRequestRecord[] {
    const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 100);
    return this.db.query<PrivacyRequestRow>(`
      SELECT ${REQUEST_COLUMNS} FROM account_privacy_requests
      WHERE user_id = ${sqlValue(userId)}
      ORDER BY id DESC LIMIT ${boundedLimit};
    `).map(toPrivacyRequest);
  }

  dueDeletions(): AccountPrivacyRequestRecord[] {
    return this.db.query<PrivacyRequestRow>(`
      SELECT ${REQUEST_COLUMNS} FROM account_privacy_requests
      WHERE request_type = 'deletion' AND status = 'scheduled'
        AND attempts < ${MAX_DELETION_ATTEMPTS}
        AND datetime(scheduled_for) <= datetime(${sqlValue(this.now().toISOString())})
      ORDER BY id ASC LIMIT 100;
    `).map(toPrivacyRequest);
  }

  deletionBlockers(userId: number): AccountDeletionBlocker[] {
    const rows = this.db.query<OwnedWorkspaceRow>(`
      SELECT w.id AS workspace_id, w.name AS workspace_name,
        (SELECT COUNT(*) FROM workspace_memberships members
          WHERE members.workspace_id = w.id AND members.status = 'active') AS member_count,
        COALESCE(plan.monthly_price_minor, 0) AS plan_price_minor,
        COALESCE(subscription.state, '') AS subscription_state
      FROM workspace_memberships membership
      JOIN workspaces w ON w.id = membership.workspace_id
      LEFT JOIN workspace_subscriptions subscription ON subscription.workspace_id = w.id
      LEFT JOIN billing_plans plan ON plan.key = subscription.plan_key
      WHERE membership.user_id = ${sqlValue(userId)}
        AND membership.role = 'owner' AND membership.status = 'active'
        AND w.deleted_at IS NULL
      ORDER BY w.id ASC;
    `);
    const blockers: AccountDeletionBlocker[] = [];
    for (const row of rows) {
      if (Number(row.member_count) > 1) {
        blockers.push({
          code: 'OWNERSHIP_TRANSFER_REQUIRED',
          workspaceId: Number(row.workspace_id),
          workspaceName: row.workspace_name,
        });
      }
      if (
        Number(row.plan_price_minor) > 0
        && ['trialing', 'active', 'past_due', 'incomplete'].includes(row.subscription_state)
      ) {
        blockers.push({
          code: 'ACTIVE_PAID_SUBSCRIPTION',
          workspaceId: Number(row.workspace_id),
          workspaceName: row.workspace_name,
        });
      }
    }
    const heldWorkspaces = this.db.query<HeldWorkspaceRow>(`
      SELECT DISTINCT workspace.id AS workspace_id, workspace.name AS workspace_name
      FROM workspace_memberships membership
      JOIN workspaces workspace ON workspace.id = membership.workspace_id
      JOIN workspace_legal_holds hold ON hold.workspace_id = workspace.id
      WHERE membership.user_id = ${sqlValue(userId)}
        AND membership.status = 'active'
        AND workspace.deleted_at IS NULL
        AND hold.status = 'active'
      ORDER BY workspace.id ASC;
    `);
    for (const workspace of heldWorkspaces) {
      blockers.push({
        code: 'LEGAL_HOLD_ACTIVE',
        workspaceId: Number(workspace.workspace_id),
        workspaceName: workspace.workspace_name,
      });
    }
    return blockers;
  }

  ownedSingleMemberWorkspaceIds(userId: number): number[] {
    return this.db.query<{ workspace_id: number }>(`
      SELECT membership.workspace_id
      FROM workspace_memberships membership
      WHERE membership.user_id = ${sqlValue(userId)}
        AND membership.role = 'owner' AND membership.status = 'active'
        AND 1 = (SELECT COUNT(*) FROM workspace_memberships members
          WHERE members.workspace_id = membership.workspace_id AND members.status = 'active')
      ORDER BY membership.workspace_id ASC;
    `).map((row) => Number(row.workspace_id));
  }

  private requireByRequestId(requestId: string): AccountPrivacyRequestRecord {
    const request = this.findByRequestId(requestId);
    if (!request) throw new Error('account privacy request not found');
    return request;
  }
}

const REQUEST_COLUMNS = [
  'id', 'request_id', 'user_id', 'workspace_id', 'request_type', 'scope', 'status',
  'attempts', 'scheduled_for', 'completed_at', 'cancelled_at', 'failure_reason',
  'created_at', 'updated_at',
].join(', ');

function privacyEventSql(input: {
  requestId: string;
  userId: number;
  eventType: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}): string {
  return `
    INSERT INTO account_privacy_events (
      event_id, request_id, subject_hash, event_type, metadata_json, created_at
    ) VALUES (
      ${sqlValue(randomUUID())}, ${sqlValue(input.requestId)},
      ${sqlValue(subjectHash(input.userId))}, ${sqlValue(input.eventType)},
      ${sqlValue(JSON.stringify(input.metadata))}, ${sqlValue(input.createdAt)}
    );
  `;
}

function subjectHash(userId: number): string {
  return createHash('sha256').update(`primalthrum-account:${userId}`).digest('hex');
}

function boundedFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : 'account deletion failed';
  return message.replace(/[\r\n]+/g, ' ').slice(0, 256);
}

function toPrivacyRequest(row: PrivacyRequestRow): AccountPrivacyRequestRecord {
  return {
    id: Number(row.id),
    requestId: row.request_id,
    userId: Number(row.user_id),
    workspaceId: row.workspace_id === null ? null : Number(row.workspace_id),
    requestType: row.request_type,
    scope: row.scope,
    status: row.status,
    attempts: Number(row.attempts),
    scheduledFor: row.scheduled_for,
    completedAt: row.completed_at,
    cancelledAt: row.cancelled_at,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
