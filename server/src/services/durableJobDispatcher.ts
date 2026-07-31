import { InProcessJobWorker } from './inProcessJobWorker';
import { JobRepository, type JobRecord } from './jobRepository';

type JobHandler = (payload: Record<string, unknown>) => Record<string, unknown>;

export class DurableJobDispatcher {
  private readonly worker: InProcessJobWorker;
  private running = false;
  private scheduled = false;

  constructor(
    private readonly jobs: JobRepository,
    private readonly handlers: Record<string, JobHandler>,
  ) {
    this.worker = new InProcessJobWorker(jobs);
  }

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
      this.drain();
    });
  }

  private drain(): void {
    if (this.running) return;
    this.running = true;
    try {
      while (true) {
        const job = this.jobs.nextRunnable(Object.keys(this.handlers));
        if (!job) break;
        this.run(job);
      }
    } finally {
      this.running = false;
    }
  }

  private run(job: JobRecord): void {
    const handler = this.handlers[job.type];
    if (!handler) return;
    this.worker.run(job.id, () => handler(job.payload));
  }
}
