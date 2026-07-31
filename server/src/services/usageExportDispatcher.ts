import { type StructuredLogger } from './logger';
import { UsageExportOutboxRepository } from './usageExportOutboxRepository';
import { type UsageMeterExporter } from './usageMeterExporter';

export class UsageExportDispatcher {
  private activeDrain: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly outbox: UsageExportOutboxRepository,
    private readonly exporter: UsageMeterExporter,
    private readonly logger: StructuredLogger,
    private readonly batchSize = 50,
  ) {}

  kick(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    void this.drain().catch((error) => {
      this.logger.log({
        level: 'error',
        code: 'USAGE_METER_DISPATCH_FAILED',
        message: error instanceof Error ? error.message : 'usage meter dispatcher failed',
      });
    });
  }

  drain(): Promise<void> {
    if (this.activeDrain) return this.activeDrain;
    let hasMore = false;
    const task = this.processBatch()
      .then((batchFilled) => { hasMore = batchFilled; })
      .finally(() => {
        if (this.activeDrain === task) this.activeDrain = null;
        if (hasMore) queueMicrotask(() => this.kick());
        else this.scheduleNextAttempt();
      });
    this.activeDrain = task;
    return task;
  }

  private async processBatch(): Promise<boolean> {
    for (let index = 0; index < this.batchSize; index += 1) {
      const item = this.outbox.claimNext(this.exporter.destination);
      if (!item) return false;
      try {
        await this.exporter.send(item.payload);
        this.outbox.markDelivered(item.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'usage meter export failed';
        this.outbox.markFailed(item.id, item.attempts, message);
        this.logger.log({
          level: 'warn',
          code: 'USAGE_METER_EXPORT_FAILED',
          message,
          context: { exportId: item.id, eventId: item.payload.eventId },
        });
      }
    }
    return true;
  }

  private scheduleNextAttempt(): void {
    const delayMs = this.outbox.nextAttemptDelayMs(this.exporter.destination);
    if (delayMs === null || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.kick();
    }, Math.max(delayMs, 25));
    if (typeof this.retryTimer === 'object' && 'unref' in this.retryTimer) {
      this.retryTimer.unref();
    }
  }
}
