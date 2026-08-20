import { type JobRecord } from './jobRepository';
import { type JobStore } from './jobStore';
import { type WorkerTraceExporter } from './workerTraceExporter';
import { traceWorkerOperation } from './workerTracing';

type JobHandler = (
  payload: Record<string, unknown>,
) => Record<string, unknown> | Promise<Record<string, unknown>>;
type DispatchErrorHandler = (error: unknown) => void;

export class DurableJobDispatcher {
  private running = false;
  private acceptingWork = true;
  private scheduled: NodeJS.Immediate | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private activeDrain: Promise<void> | null = null;
  private recovery: Promise<void> | null = null;
  private lastRecoveryAt = 0;

  constructor(
    private readonly jobs: JobStore,
    private readonly handlers: Record<string, JobHandler>,
    private readonly onDispatchError: DispatchErrorHandler = () => undefined,
    private readonly heartbeatIntervalMs = 30_000,
    private readonly traceExporter?: WorkerTraceExporter,
  ) {}

  resume(): void {
    this.acceptingWork = true;
    if (!this.recovery) {
      this.recovery = Promise.resolve()
        .then(() => this.jobs.recoverInterrupted(Object.keys(this.handlers)))
        .then(() => { this.lastRecoveryAt = Date.now(); });
    }
    void this.recovery.then(() => this.kick()).catch(this.onDispatchError);
  }

  start(pollIntervalMs = 1_000, unref = true): void {
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 25) {
      throw new Error('job dispatcher poll interval is invalid');
    }
    this.resume();
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.kick(), pollIntervalMs);
    if (unref) this.pollTimer.unref();
  }

  kick(): void {
    if (!this.acceptingWork || this.running || this.scheduled) return;
    this.scheduled = setImmediate(() => {
      this.scheduled = null;
      if (!this.acceptingWork || this.activeDrain) return;
      const drain = this.drain().finally(() => {
        if (this.activeDrain === drain) this.activeDrain = null;
      });
      this.activeDrain = drain;
      void drain.catch(this.onDispatchError);
    });
  }

  async stop(): Promise<void> {
    this.acceptingWork = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.scheduled) {
      clearImmediate(this.scheduled);
      this.scheduled = null;
    }
    await this.recovery?.catch(() => undefined);
    await this.activeDrain?.catch(() => undefined);
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (this.recovery) await this.recovery;
      await this.recoverExpiredIfDue();
      while (this.acceptingWork) {
        const job = await this.jobs.claimNext(Object.keys(this.handlers));
        if (!job) break;
        await this.run(job);
      }
    } finally {
      this.running = false;
    }
  }

  private async recoverExpiredIfDue(): Promise<void> {
    const now = Date.now();
    if (now - this.lastRecoveryAt < this.heartbeatIntervalMs) return;
    await this.jobs.recoverInterrupted(Object.keys(this.handlers));
    this.lastRecoveryAt = now;
  }

  private async run(job: JobRecord): Promise<void> {
    const handler = this.handlers[job.type];
    if (!handler) return;
    const heartbeat = setInterval(() => {
      void Promise.resolve(this.jobs.renewLease(job.id)).catch(this.onDispatchError);
    }, this.heartbeatIntervalMs);
    heartbeat.unref();
    try {
      await traceWorkerOperation(this.traceExporter, {
        queue: 'durable_job',
        operation: job.type,
        messageId: String(job.id),
        attempt: job.attempts,
      }, async () => {
        const result = await handler(job.payload);
        await this.jobs.markSucceeded(job.id, result);
      });
    } catch (error) {
      await this.jobs.markFailed(
        job.id,
        error instanceof Error ? error.message : 'job failed',
      );
    } finally {
      clearInterval(heartbeat);
    }
  }

}
