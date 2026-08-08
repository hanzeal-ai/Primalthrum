import { type AccountPrivacyStore } from './accountPrivacyStore';
import { type JobStore } from './jobStore';

const DEFAULT_INTERVAL_MS = 60_000;

export class AccountPrivacyScheduler {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private readonly privacy: AccountPrivacyStore,
    private readonly jobs: JobStore,
    private readonly kick: () => void,
    private readonly intervalMs = DEFAULT_INTERVAL_MS,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {
    if (!Number.isInteger(intervalMs) || intervalMs < 100) {
      throw new Error('account privacy scheduler interval is invalid');
    }
  }

  start(): void {
    this.scheduleTick();
    if (this.timer) return;
    this.timer = setInterval(() => this.scheduleTick(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    let created = 0;
    try {
      for (const request of await this.privacy.dueDeletions()) {
        const job = await this.jobs.createUnique({
          type: 'account.delete',
          workspaceId: request.workspaceId ?? undefined,
          payload: { requestId: request.requestId },
          maxAttempts: 3,
          dedupeKey: `request:${request.requestId}`,
        });
        if (job) created += 1;
      }
      if (created) this.kick();
    } finally {
      this.ticking = false;
    }
  }

  private scheduleTick(): void {
    void this.tick().catch(this.onError);
  }
}
