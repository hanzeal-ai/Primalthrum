import { type DatabaseAdapter } from '../db/adapter';
import { sqlValue } from '../db/sql';
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

export class AccountEmailOutboxRepository implements AccountEmailOutboxStore {
  constructor(
    private readonly db: DatabaseAdapter,
    private readonly now: () => Date = () => new Date(),
    private readonly onEnqueued?: () => void,
  ) {
  }

  enqueue(input: Omit<AccountEmailMessage, 'id'>): void {
    const context = emailContext(input);
    this.db.run(`
      INSERT INTO account_email_outbox (
        user_id, workspace_id, invitation_id, template, recipient_email, payload_json
      ) VALUES (
        ${sqlValue(context.userId)}, ${sqlValue(context.workspaceId)},
        ${sqlValue(context.invitationId)}, ${sqlValue(input.template)},
        ${sqlValue(input.recipientEmail)}, ${sqlValue(JSON.stringify(input.payload))}
      );
    `);
    this.onEnqueued?.();
  }

  supersedePending(userId: number, template: AccountEmailMessage['template']): void {
    this.db.run(`
      UPDATE account_email_outbox
      SET status = 'superseded', payload_json = '{}',
        updated_at = ${sqlValue(this.now().toISOString())}
      WHERE user_id = ${sqlValue(userId)} AND template = ${sqlValue(template)}
        AND status IN ('pending', 'failed');
    `);
  }

  supersedePendingInvitations(workspaceId: number, recipientEmail: string, exceptInvitationId?: number): void {
    this.db.run(`
      UPDATE account_email_outbox
      SET status = 'superseded', payload_json = '{}',
        updated_at = ${sqlValue(this.now().toISOString())}
      WHERE workspace_id = ${sqlValue(workspaceId)}
        AND recipient_email = ${sqlValue(recipientEmail)}
        AND template = 'workspace_invitation'
        ${exceptInvitationId ? `AND invitation_id <> ${sqlValue(exceptInvitationId)}` : ''}
        AND status IN ('pending', 'delivering', 'failed');
    `);
  }

  supersedeInvitation(invitationId: number): void {
    this.db.run(`
      UPDATE account_email_outbox
      SET status = 'superseded', payload_json = '{}',
        updated_at = ${sqlValue(this.now().toISOString())}
      WHERE invitation_id = ${sqlValue(invitationId)}
        AND template = 'workspace_invitation'
        AND status IN ('pending', 'delivering', 'failed');
    `);
  }

  claimNext(): ClaimedAccountEmail | null {
    const now = this.now().toISOString();
    this.db.run(`
      UPDATE account_email_outbox
      SET status = 'failed', last_error = 'delivery lease expired',
        next_attempt_at = ${sqlValue(now)}, updated_at = ${sqlValue(now)}
      WHERE status = 'delivering'
        AND datetime(updated_at) <= datetime(${sqlValue(now)}, '-5 minutes');
    `);
    const row = this.db.query<{
      id: number;
      template: AccountEmailMessage['template'];
      recipient_email: string;
      payload_json: string;
      attempts: number;
    }>(`
      UPDATE account_email_outbox
      SET status = 'delivering', attempts = attempts + 1, updated_at = ${sqlValue(now)}
      WHERE id = (
        SELECT id FROM account_email_outbox
        WHERE status IN ('pending', 'failed')
          AND dead_lettered_at IS NULL
          AND datetime(next_attempt_at) <= datetime(${sqlValue(now)})
        ORDER BY id LIMIT 1
      )
      RETURNING id, template, recipient_email, payload_json, attempts;
    `)[0];
    return row ? {
      id: Number(row.id),
      template: row.template,
      recipientEmail: row.recipient_email,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      attempts: Number(row.attempts),
    } : null;
  }

  markDelivered(id: number, receipt: AccountEmailDeliveryReceipt): void {
    validateProviderIdentity(receipt.provider, receipt.providerMessageId);
    const now = this.now().toISOString();
    this.db.run(`
      UPDATE account_email_outbox SET status = 'delivered', last_error = '',
        payload_json = '{}',
        provider = ${sqlValue(receipt.provider)},
        provider_message_id = ${sqlValue(receipt.providerMessageId)},
        accepted_at = ${sqlValue(now)}, delivered_at = ${sqlValue(now)},
        last_provider_status = 'accepted', updated_at = ${sqlValue(now)}
      WHERE id = ${sqlValue(id)} AND status = 'delivering';
    `);
    this.recordProviderEvent({
      provider: receipt.provider,
      providerEventId: `accepted:${id}`,
      providerMessageId: receipt.providerMessageId,
      eventType: 'accepted',
      occurredAt: now,
    });
  }

  markFailed(
    id: number,
    attempts: number,
    error: string,
    options: { retryable?: boolean; retryAfterMs?: number; maxAttempts?: number } = {},
  ): { deadLettered: boolean } {
    const deadLettered = options.retryable === false || attempts >= (options.maxAttempts ?? 8);
    const requestedDelayMs = options.retryAfterMs
      ?? Math.min(3_600_000, 1000 * (2 ** Math.min(Math.max(attempts - 1, 0), 12)));
    const delayMs = Math.min(Math.max(requestedDelayMs, 0), 3_600_000);
    const now = this.now();
    this.db.run(`
      UPDATE account_email_outbox SET status = 'failed',
        last_error = ${sqlValue(error.slice(0, 1000))},
        next_attempt_at = ${sqlValue(new Date(now.getTime() + delayMs).toISOString())},
        dead_lettered_at = ${deadLettered ? sqlValue(now.toISOString()) : 'NULL'},
        payload_json = ${deadLettered ? "'{}'" : 'payload_json'},
        updated_at = ${sqlValue(now.toISOString())}
      WHERE id = ${sqlValue(id)} AND status = 'delivering';
    `);
    return { deadLettered };
  }

  nextAttemptDelayMs(): number | null {
    const row = this.db.query<{ delay_ms: number | null }>(`
      SELECT MAX(0, CAST(
        (julianday(MIN(next_attempt_at)) - julianday(${sqlValue(this.now().toISOString())})) * 86400000
        AS INTEGER
      )) AS delay_ms
      FROM account_email_outbox
      WHERE status IN ('pending', 'failed') AND dead_lettered_at IS NULL;
    `)[0];
    return row?.delay_ms === null || row?.delay_ms === undefined ? null : Number(row.delay_ms);
  }

  recordProviderEvent(input: AccountEmailProviderEvent): AccountEmailProviderEventResult {
    const existing = this.db.query<{
      outbox_id: number | null;
      provider_message_id: string;
      event_type: AccountEmailProviderEventType;
      occurred_at: string;
    }>(`
      SELECT outbox_id, provider_message_id, event_type, occurred_at
      FROM account_email_delivery_events
      WHERE provider = ${sqlValue(input.provider)}
        AND provider_event_id = ${sqlValue(input.providerEventId)}
      LIMIT 1;
    `)[0];
    if (existing) {
      if (existing.provider_message_id !== input.providerMessageId
        || existing.event_type !== input.eventType
        || existing.occurred_at !== input.occurredAt) {
        throw new Error('account email provider event idempotency conflict');
      }
      return {
        duplicate: true,
        matched: existing.outbox_id !== null,
        outboxId: existing.outbox_id === null ? null : Number(existing.outbox_id),
      };
    }

    const outbox = this.db.query<{ id: number }>(`
      SELECT id FROM account_email_outbox
      WHERE provider = ${sqlValue(input.provider)}
        AND provider_message_id = ${sqlValue(input.providerMessageId)}
      ORDER BY id DESC LIMIT 1;
    `)[0];
    const outboxId = outbox ? Number(outbox.id) : null;
    this.db.run(`
      INSERT INTO account_email_delivery_events (
        provider, provider_event_id, provider_message_id, outbox_id,
        event_type, occurred_at
      ) VALUES (
        ${sqlValue(input.provider)}, ${sqlValue(input.providerEventId)},
        ${sqlValue(input.providerMessageId)}, ${sqlValue(outboxId)},
        ${sqlValue(input.eventType)}, ${sqlValue(input.occurredAt)}
      );
    `);
    if (outboxId !== null) {
      this.db.run(`
        UPDATE account_email_outbox
        SET last_provider_status = ${sqlValue(input.eventType)},
          updated_at = ${sqlValue(this.now().toISOString())}
        WHERE id = ${sqlValue(outboxId)};
      `);
    }
    return { duplicate: false, matched: outboxId !== null, outboxId };
  }

  summary(): AccountEmailDeliverySummary {
    const row = this.db.query<Record<string, number>>(`
      SELECT
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'delivering' THEN 1 ELSE 0 END) AS delivering,
        SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
        SUM(CASE WHEN status = 'failed' AND dead_lettered_at IS NULL THEN 1 ELSE 0 END) AS retrying,
        SUM(CASE WHEN status = 'failed' AND dead_lettered_at IS NOT NULL THEN 1 ELSE 0 END) AS dead_lettered,
        SUM(CASE WHEN last_provider_status = 'bounced' THEN 1 ELSE 0 END) AS bounced,
        SUM(CASE WHEN last_provider_status = 'complained' THEN 1 ELSE 0 END) AS complained
      FROM account_email_outbox;
    `)[0] ?? {};
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
