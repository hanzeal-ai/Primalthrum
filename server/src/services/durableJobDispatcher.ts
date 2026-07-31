import { JobRepository, type JobRecord } from './jobRepository';

type JobHandler = (
  payload: Record<string, unknown>,
) => Record<string, unknown> | Promise<Record<string, unknown>>;
type DispatchErrorHandler = (error: unknown) => void;

export class DurableJobDispatcher {
  private running = false;
  private scheduled = false;

  constructor(
    private readonly jobs: JobRepository,
    private readonly handlers: Record<string, JobHandler>,
    private readonly onDispatchError: DispatchErrorHandler = () => undefined,
  ) {}

  resume(): void {
    const types = Object.keys(this.handlers);
    this.jobs.recoverInterrupted(types);
    if (this.jobs.nextRunnable(types)) {
      this.kick();
    }
  }

  kick(): void {
    if (this.running || this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      void this.drain().catch(this.onDispatchError);
    });
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (true) {
        const job = this.jobs.nextRunnable(Object.keys(this.handlers));
        if (!job) break;
        await this.run(job);
      }
    } finally {
      this.running = false;
    }
  }

  private async run(job: JobRecord): Promise<void> {
    const handler = this.handlers[job.type];
    if (!handler) return;
    const running = this.jobs.markRunning(job.id);
    try {
      const result = await handler(job.payload);
      this.jobs.markSucceeded(running.id, result);
    } catch (error) {
      this.jobs.markFailed(
        running.id,
        error instanceof Error ? error.message : 'job failed',
      );
    }
  }
}
