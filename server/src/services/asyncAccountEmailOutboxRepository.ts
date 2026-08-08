import {
  type AsyncDatabaseAdapter,
  type AsyncDatabaseSession,
} from '../db/asyncAdapter';
import { databaseTimestamp } from '../db/databaseTimestamp';
import {
  type AccountEmailDeliveryReceipt,
  type AccountEmailMessage,
} from './accountEmailSender';
import {
  type AccountEmailDeliverySummary,
  type AccountEmailOutboxStore,
  type AccountEmailProviderEvent,
  type AccountEmailProviderEventResult,
  type AccountEmailProviderEventType,
  type ClaimedAccountEmail,
} from './accountEmailOutboxStore';

interface AccountEmailRow {
  id: number;
  template: AccountEmailMessage['template'];
  recipient_email: string;
  payload_json: string;
  attempts: number;
}

interface ProviderEventRow {
  outbox_id: number | null;
  provider_message_id: string;
  event_type: AccountEmailProviderEventType;
  occurred_at: string | Date;
}

export class AsyncAccountEmailOutboxRepository implements AccountEmailOutboxStore {
  constructor(
    private readonly database: AsyncDatabaseAdapter,
    private readonly now: () => Date = () => new Date(),
    private readonly onEnqueued?: () => void,
  ) {}

  async enqueue(input: Omit<AccountEmailMessage, 'id'>): Promise<void> {
    const context = emailContext(input);
    await this.database.execute({
      text: `
        INSERT INTO account_email_outbox (
          user_id, workspace_id, invitation_id, template, recipient_email, payload_json
        ) VALUES ($1, $2, $3, $4, $5, $6);
      `,
      values: [
        context.userId,
        context.workspaceId,
        context.invitationId,
        input.template,
        input.recipientEmail,
        JSON.stringify(input.payload),
      ],
    });
    this.onEnqueued?.();
  }

  async supersedePending(
    userId: number,
    template: AccountEmailMessage['template'],
  ): Promise<void> {
    await this.database.execute({
      text: `
        UPDATE account_email_outbox
        SET status = 'superseded', payload_json = '{}', updated_at = $3
        WHERE user_id = $1 AND template = $2 AND status IN ('pending', 'failed');
      `,
      values: [userId, template, this.now().toISOString()],
    });
  }

  async supersedePendingInvitations(
    workspaceId: number,
    recipientEmail: string,
    exceptInvitationId?: number,
  ): Promise<void> {
    const values = exceptInvitationId === undefined
      ? [workspaceId, recipientEmail, this.now().toISOString()]
      : [workspaceId, recipientEmail, this.now().toISOString(), exceptInvitationId];
    await this.database.execute({
      text: `
        UPDATE account_email_outbox
        SET status = 'superseded', payload_json = '{}', updated_at = $3
        WHERE workspace_id = $1 AND recipient_email = $2
          AND template = 'workspace_invitation'
          ${exceptInvitationId === undefined ? '' : 'AND invitation_id <> $4'}
          AND status IN ('pending', 'delivering', 'failed');
      `,
      values,
    });
  }

  async supersedeInvitation(invitationId: number): Promise<void> {
    await this.database.execute({
      text: `
        UPDATE account_email_outbox
        SET status = 'superseded', payload_json = '{}', updated_at = $2
        WHERE invitation_id = $1 AND template = 'workspace_invitation'
          AND status IN ('pending', 'delivering', 'failed');
      `,
      values: [invitationId, this.now().toISOString()],
    });
  }

  claimNext(): Promise<ClaimedAccountEmail | null> {
    const now = this.now().toISOString();
    return this.database.transaction(async (session) => {
      await session.execute({
        text: this.database.dialect === 'postgres'
          ? `
              UPDATE account_email_outbox
              SET status = 'failed', last_error = 'delivery lease expired',
                next_attempt_at = $1, updated_at = $1
              WHERE status = 'delivering'
                AND updated_at <= $1::timestamptz - INTERVAL '5 minutes';
            `
          : `
              UPDATE account_email_outbox
              SET status = 'failed', last_error = 'delivery lease expired',
                next_attempt_at = $1, updated_at = $1
              WHERE status = 'delivering'
                AND datetime(updated_at) <= datetime($1, '-5 minutes');
            `,
        values: [now],
      });
      const rows = await session.query<AccountEmailRow>({
        text: this.database.dialect === 'postgres'
          ? `
              WITH candidate AS (
                SELECT id FROM account_email_outbox
                WHERE status IN ('pending', 'failed') AND dead_lettered_at IS NULL
                  AND next_attempt_at <= $1
                ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1
              )
              UPDATE account_email_outbox AS email
              SET status = 'delivering', attempts = email.attempts + 1, updated_at = $1
              FROM candidate WHERE email.id = candidate.id
              RETURNING email.id, email.template, email.recipient_email,
                email.payload_json, email.attempts;
            `
          : `
              UPDATE account_email_outbox
              SET status = 'delivering', attempts = attempts + 1, updated_at = $1
              WHERE id = (
                SELECT id FROM account_email_outbox
                WHERE status IN ('pending', 'failed') AND dead_lettered_at IS NULL
                  AND datetime(next_attempt_at) <= datetime($1)
                ORDER BY id LIMIT 1
              )
              RETURNING id, template, recipient_email, payload_json, attempts;
            `,
        values: [now],
      });
      return rows[0] ? toClaimedEmail(rows[0]) : null;
    });
  }

  markDelivered(id: number, receipt: AccountEmailDeliveryReceipt): Promise<void> {
    validateProviderIdentity(receipt.provider, receipt.providerMessageId);
    const now = this.now().toISOString();
    return this.database.transaction(async (session) => {
      const updated = await session.execute({
        text: `
          UPDATE account_email_outbox SET status = 'delivered', last_error = '',
            payload_json = '{}', provider = $2, provider_message_id = $3,
            accepted_at = $4, delivered_at = $4, last_provider_status = 'accepted',
            updated_at = $4
          WHERE id = $1 AND status = 'delivering';
        `,
        values: [id, receipt.provider, receipt.providerMessageId, now],
      });
      if (updated.rowCount !== 1) throw new Error('account email is not being delivered');
      await this.recordProviderEventInSession(session, {
        provider: receipt.provider,
        providerEventId: `accepted:${id}`,
        providerMessageId: receipt.providerMessageId,
        eventType: 'accepted',
        occurredAt: now,
      });
    });
  }

  async markFailed(
    id: number,
    attempts: number,
    error: string,
    options: { retryable?: boolean; retryAfterMs?: number; maxAttempts?: number } = {},
  ): Promise<{ deadLettered: boolean }> {
    const deadLettered = options.retryable === false || attempts >= (options.maxAttempts ?? 8);
    const requestedDelayMs = options.retryAfterMs
      ?? Math.min(3_600_000, 1000 * (2 ** Math.min(Math.max(attempts - 1, 0), 12)));
    const delayMs = Math.min(Math.max(requestedDelayMs, 0), 3_600_000);
    const now = this.now();
    const updated = await this.database.execute({
      text: this.database.dialect === 'postgres'
        ? `
            UPDATE account_email_outbox SET status = 'failed', last_error = $2,
              next_attempt_at = $3, dead_lettered_at = $4::timestamptz,
              payload_json = CASE WHEN $4::timestamptz IS NULL THEN payload_json ELSE '{}' END,
              updated_at = $5
            WHERE id = $1 AND status = 'delivering';
          `
        : `
            UPDATE account_email_outbox SET status = 'failed', last_error = $2,
              next_attempt_at = $3, dead_lettered_at = $4,
              payload_json = CASE WHEN $4 IS NULL THEN payload_json ELSE '{}' END,
              updated_at = $5
            WHERE id = $1 AND status = 'delivering';
          `,
      values: [
        id,
        error.slice(0, 1000),
        new Date(now.getTime() + delayMs).toISOString(),
        deadLettered ? now.toISOString() : null,
        now.toISOString(),
      ],
    });
    if (updated.rowCount !== 1) throw new Error('account email is not being delivered');
    return { deadLettered };
  }

  async nextAttemptDelayMs(): Promise<number | null> {
    const rows = await this.database.query<{ next_attempt_at: string | Date | null }>({
      text: `
        SELECT MIN(next_attempt_at) AS next_attempt_at FROM account_email_outbox
        WHERE status IN ('pending', 'failed') AND dead_lettered_at IS NULL;
      `,
    });
    const nextAttemptAt = rows[0]?.next_attempt_at;
    if (nextAttemptAt === null || nextAttemptAt === undefined) return null;
    return Math.max(new Date(databaseTimestamp(nextAttemptAt)).getTime() - this.now().getTime(), 0);
  }

  recordProviderEvent(
    input: AccountEmailProviderEvent,
  ): Promise<AccountEmailProviderEventResult> {
    validateProviderIdentity(input.provider, input.providerMessageId);
    return this.database.transaction(
      (session) => this.recordProviderEventInSession(session, input),
    );
  }

  async summary(): Promise<AccountEmailDeliverySummary> {
    const rows = await this.database.query<Record<string, number | string | null>>({
      text: `
        SELECT
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN status = 'delivering' THEN 1 ELSE 0 END) AS delivering,
          SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
          SUM(CASE WHEN status = 'failed' AND dead_lettered_at IS NULL THEN 1 ELSE 0 END) AS retrying,
          SUM(CASE WHEN status = 'failed' AND dead_lettered_at IS NOT NULL THEN 1 ELSE 0 END) AS dead_lettered,
          SUM(CASE WHEN last_provider_status = 'bounced' THEN 1 ELSE 0 END) AS bounced,
          SUM(CASE WHEN last_provider_status = 'complained' THEN 1 ELSE 0 END) AS complained
        FROM account_email_outbox;
      `,
    });
    const row = rows[0] ?? {};
    return {
      pending: Number(row.pending ?? 0),
      delivering: Number(row.delivering ?? 0),
      delivered: Number(row.delivered ?? 0),
      retrying: Number(row.retrying ?? 0),
      deadLettered: Number(row.dead_lettered ?? 0),
      bounced: Number(row.bounced ?? 0),
      complained: Number(row.complained ?? 0),
    };
  }

  private async recordProviderEventInSession(
    session: AsyncDatabaseSession,
    input: AccountEmailProviderEvent,
  ): Promise<AccountEmailProviderEventResult> {
    const outboxRows = await session.query<{ id: number }>({
      text: `
        SELECT id FROM account_email_outbox
        WHERE provider = $1 AND provider_message_id = $2
        ORDER BY id DESC LIMIT 1;
      `,
      values: [input.provider, input.providerMessageId],
    });
    const outboxId = outboxRows[0] ? Number(outboxRows[0].id) : null;
    const inserted = await session.query<{ id: number }>({
      text: `
        INSERT INTO account_email_delivery_events (
          provider, provider_event_id, provider_message_id, outbox_id,
          event_type, occurred_at
        ) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT(provider, provider_event_id) DO NOTHING
        RETURNING id;
      `,
      values: [
        input.provider,
        input.providerEventId,
        input.providerMessageId,
        outboxId,
        input.eventType,
        input.occurredAt,
      ],
    });
    if (!inserted[0]) {
      const existingRows = await session.query<ProviderEventRow>({
        text: `
          SELECT outbox_id, provider_message_id, event_type, occurred_at
          FROM account_email_delivery_events
          WHERE provider = $1 AND provider_event_id = $2 LIMIT 1;
        `,
        values: [input.provider, input.providerEventId],
      });
      const existing = existingRows[0];
      if (!existing
        || existing.provider_message_id !== input.providerMessageId
        || existing.event_type !== input.eventType
        || databaseTimestamp(existing.occurred_at) !== databaseTimestamp(input.occurredAt)) {
        throw new Error('account email provider event idempotency conflict');
      }
      return {
        duplicate: true,
        matched: existing.outbox_id !== null,
        outboxId: existing.outbox_id === null ? null : Number(existing.outbox_id),
      };
    }
    if (outboxId !== null) {
      await session.execute({
        text: `
          UPDATE account_email_outbox SET last_provider_status = $2, updated_at = $3
          WHERE id = $1;
        `,
        values: [outboxId, input.eventType, this.now().toISOString()],
      });
    }
    return { duplicate: false, matched: outboxId !== null, outboxId };
  }
}

function toClaimedEmail(row: AccountEmailRow): ClaimedAccountEmail {
  return {
    id: Number(row.id),
    template: row.template,
    recipientEmail: row.recipient_email,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    attempts: Number(row.attempts),
  };
}

function emailContext(input: Omit<AccountEmailMessage, 'id'>): {
  userId: number | null;
  workspaceId: number | null;
  invitationId: number | null;
} {
  if (input.template === 'workspace_invitation') {
    return {
      userId: null,
      workspaceId: positiveInteger(input.payload.workspaceId, 'workspace invitation workspace'),
      invitationId: positiveInteger(input.payload.invitationId, 'workspace invitation'),
    };
  }
  return {
    userId: positiveInteger(input.payload.userId, 'account email user'),
    workspaceId: null,
    invitationId: null,
  };
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} id is invalid`);
  }
  return value;
}

function validateProviderIdentity(provider: string, providerMessageId: string): void {
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(provider)) {
    throw new Error('account email provider is invalid');
  }
  if (!providerMessageId || providerMessageId.length > 255) {
    throw new Error('account email provider message id is invalid');
  }
}
