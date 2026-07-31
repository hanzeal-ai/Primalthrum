import { type StructuredLogger } from './logger';
import { AccountEmailOutboxRepository } from './accountEmailOutboxRepository';
import {
  AccountEmailDeliveryError,
  type AccountEmailSender,
} from './accountEmailSender';

export class AccountEmailDispatcher {
  private activeDrain: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly outbox: AccountEmailOutboxRepository,
    private readonly sender: AccountEmailSender,
    private readonly logger: StructuredLogger,
    private readonly batchSize = 25,
  ) {}

  kick(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    void this.drain().catch((error) => this.logger.log({
      level: 'error', code: 'ACCOUNT_EMAIL_DISPATCH_FAILED',
      message: error instanceof Error ? error.message : 'account email dispatcher failed',
    }));
  }

  drain(): Promise<void> {
    if (this.activeDrain) return this.activeDrain;
    let hasMore = false;
    const task = this.processBatch().then((filled) => { hasMore = filled; }).finally(() => {
      if (this.activeDrain === task) this.activeDrain = null;
      if (hasMore) queueMicrotask(() => this.kick());
      else this.scheduleNext();
    });
    this.activeDrain = task;
    return task;
  }

  private async processBatch(): Promise<boolean> {
    for (let index = 0; index < this.batchSize; index += 1) {
      const message = this.outbox.claimNext();
      if (!message) return false;
      try {
        const receipt = await this.sender.send(message);
        this.outbox.markDelivered(message.id, receipt);
        this.logger.log({
          level: 'info',
          code: 'ACCOUNT_EMAIL_ACCEPTED',
          message: 'account email accepted by provider',
          context: {
            emailId: message.id,
            template: message.template,
            provider: receipt.provider,
            providerMessageId: receipt.providerMessageId,
          },
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'account email delivery failed';
        const failure = this.outbox.markFailed(message.id, message.attempts, detail, {
          retryable: error instanceof AccountEmailDeliveryError ? error.retryable : true,
          retryAfterMs: error instanceof AccountEmailDeliveryError ? error.retryAfterMs : undefined,
        });
        this.logger.log({
          level: failure.deadLettered ? 'error' : 'warn',
          code: failure.deadLettered
            ? 'ACCOUNT_EMAIL_DEAD_LETTERED'
            : 'ACCOUNT_EMAIL_DELIVERY_FAILED',
          message: detail,
          context: {
            emailId: message.id,
            template: message.template,
            attempts: message.attempts,
            retryable: !failure.deadLettered,
          },
        });
      }
    }
    return true;
  }

  private scheduleNext(): void {
    const delayMs = this.outbox.nextAttemptDelayMs();
    if (delayMs === null || this.retryTimer) return;
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.kick(); }, Math.max(delayMs, 25));
    if (typeof this.retryTimer === 'object' && 'unref' in this.retryTimer) this.retryTimer.unref();
  }
}
