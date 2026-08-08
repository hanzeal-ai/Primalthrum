import { type JobRecord } from './jobRepository';
import { type JobStore } from './jobStore';

type JobHandler = (
  payload: Record<string, unknown>,
) => Record<string, unknown> | Promise<Record<string, unknown>>;
type DispatchErrorHandler = (error: unknown) => void;

export class DurableJobDispatcher {
  private running = false;
  private scheduled = false;
  private recovery: Promise<void> | null = null;

  constructor(
    private readonly jobs: JobStore,
    private readonly handlers: Record<string, JobHandler>,
    private readonly onDispatchError: DispatchErrorHandler = () => undefined,
  ) {}

  resume(): void {
    if (this.recovery) return;
    this.recovery = Promise.resolve()
      .then(() => this.jobs.recoverInterrupted(Object.keys(this.handlers)));
    void this.recovery.then(() => this.kick()).catch(this.onDispatchError);
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
      if (this.recovery) await this.recovery;
      while (true) {
        const job = await this.jobs.claimNext(Object.keys(this.handlers));
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
    try {
      const result = await handler(job.payload);
      await this.jobs.markSucceeded(job.id, result);
    } catch (error) {
      await this.jobs.markFailed(
        job.id,
        error instanceof Error ? error.message : 'job failed',
      );
    }
  }

}
