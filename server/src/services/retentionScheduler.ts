import { type JobStore } from './jobStore';
import { type RetentionPolicyStore } from './retentionPolicyStore';

const DEFAULT_INTERVAL_MS = 60 * 60_000;

export class RetentionScheduler {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private readonly policies: RetentionPolicyStore,
    private readonly jobs: JobStore,
    private readonly kick: () => void,
    private readonly intervalMs = DEFAULT_INTERVAL_MS,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

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

  async trigger(workspaceId: number): Promise<void> {
    const job = await this.jobs.createUnique({
      type: 'retention.enforce',
      workspaceId,
      payload: { workspaceId },
      maxAttempts: 3,
      dedupeKey: `workspace:${workspaceId}`,
    });
    if (job) this.kick();
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const workspaceId of await this.policies.dueWorkspaceIds()) {
        await this.trigger(workspaceId);
      }
    } finally {
      this.ticking = false;
    }
  }

  private scheduleTick(): void {
    void this.tick().catch(this.onError);
  }
}
