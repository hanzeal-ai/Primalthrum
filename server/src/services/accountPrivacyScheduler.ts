import { AccountPrivacyRepository } from './accountPrivacyRepository';
import { JobRepository } from './jobRepository';

const DEFAULT_INTERVAL_MS = 60_000;

export class AccountPrivacyScheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly privacy: AccountPrivacyRepository,
    private readonly jobs: JobRepository,
    private readonly kick: () => void,
    private readonly intervalMs = DEFAULT_INTERVAL_MS,
  ) {
    if (!Number.isInteger(intervalMs) || intervalMs < 100) {
      throw new Error('account privacy scheduler interval is invalid');
    }
  }

  start(): void {
    this.tick();
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  tick(): void {
    let created = 0;
    for (const request of this.privacy.dueDeletions()) {
      if (this.jobs.hasActiveForPayload('account.delete', 'requestId', request.requestId)) continue;
      this.jobs.create({
        type: 'account.delete',
        workspaceId: request.workspaceId ?? undefined,
        payload: { requestId: request.requestId },
        maxAttempts: 3,
      });
      created += 1;
    }
    if (created) this.kick();
  }
}
