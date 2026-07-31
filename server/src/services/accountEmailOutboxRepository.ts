import { initializeSchema } from '../db/schema';
import { SqliteDatabase, sqlValue } from '../db/sqlite';
import { type AccountEmailMessage } from './accountEmailSender';

export interface ClaimedAccountEmail extends AccountEmailMessage {
  attempts: number;
}

export class AccountEmailOutboxRepository {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly now: () => Date = () => new Date(),
    private readonly onEnqueued?: () => void,
  ) {
    initializeSchema(db);
  }

  enqueue(input: Omit<AccountEmailMessage, 'id'>): void {
    this.db.run(`
      INSERT INTO account_email_outbox (
        user_id, template, recipient_email, payload_json
      ) VALUES (
        ${sqlValue(Number(input.payload.userId))}, ${sqlValue(input.template)},
        ${sqlValue(input.recipientEmail)}, ${sqlValue(JSON.stringify(input.payload))}
      );
    `);
    this.onEnqueued?.();
  }

  supersedePending(userId: number, template: AccountEmailMessage['template']): void {
    this.db.run(`
      UPDATE account_email_outbox
      SET status = 'superseded', updated_at = ${sqlValue(this.now().toISOString())}
      WHERE user_id = ${sqlValue(userId)} AND template = ${sqlValue(template)}
        AND status IN ('pending', 'failed');
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
      template: 'verify_email' | 'reset_password';
      recipient_email: string;
      payload_json: string;
      attempts: number;
    }>(`
      UPDATE account_email_outbox
      SET status = 'delivering', attempts = attempts + 1, updated_at = ${sqlValue(now)}
      WHERE id = (
        SELECT id FROM account_email_outbox
        WHERE status IN ('pending', 'failed')
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

  markDelivered(id: number): void {
    const now = this.now().toISOString();
    this.db.run(`
      UPDATE account_email_outbox SET status = 'delivered', last_error = '',
        delivered_at = ${sqlValue(now)}, updated_at = ${sqlValue(now)}
      WHERE id = ${sqlValue(id)} AND status = 'delivering';
    `);
  }

  markFailed(id: number, attempts: number, error: string): void {
    const delayMs = Math.min(3_600_000, 1000 * (2 ** Math.min(Math.max(attempts - 1, 0), 12)));
    const now = this.now();
    this.db.run(`
      UPDATE account_email_outbox SET status = 'failed',
        last_error = ${sqlValue(error.slice(0, 1000))},
        next_attempt_at = ${sqlValue(new Date(now.getTime() + delayMs).toISOString())},
        updated_at = ${sqlValue(now.toISOString())}
      WHERE id = ${sqlValue(id)} AND status = 'delivering';
    `);
  }

  nextAttemptDelayMs(): number | null {
    const row = this.db.query<{ delay_ms: number | null }>(`
      SELECT MAX(0, CAST(
        (julianday(MIN(next_attempt_at)) - julianday(${sqlValue(this.now().toISOString())})) * 86400000
        AS INTEGER
      )) AS delay_ms
      FROM account_email_outbox WHERE status IN ('pending', 'failed');
    `)[0];
    return row?.delay_ms === null || row?.delay_ms === undefined ? null : Number(row.delay_ms);
  }
}
