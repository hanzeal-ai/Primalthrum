import { JobRepository } from './jobRepository';
import { RetentionPolicyRepository } from './retentionPolicyRepository';

const DEFAULT_INTERVAL_MS = 60 * 60_000;

export class RetentionScheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly policies: RetentionPolicyRepository,
    private readonly jobs: JobRepository,
    private readonly kick: () => void,
    private readonly intervalMs = DEFAULT_INTERVAL_MS,
  ) {}

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

  trigger(workspaceId: number): void {
    if (this.jobs.hasActive('retention.enforce', workspaceId)) return;
    this.jobs.create({
      type: 'retention.enforce',
      workspaceId,
      payload: { workspaceId },
      maxAttempts: 3,
    });
    this.kick();
  }

  tick(): void {
    for (const workspaceId of this.policies.dueWorkspaceIds()) {
      this.trigger(workspaceId);
    }
  }
}
