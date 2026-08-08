import { type JobRecord } from './jobRepository';
import { type JobStore } from './jobStore';

export class InProcessJobWorker {
  constructor(private readonly jobs: JobStore) {}

  async run(
    jobId: number,
    handler: () => Record<string, unknown> | Promise<Record<string, unknown>>,
  ): Promise<JobRecord> {
    const running = await this.jobs.markRunning(jobId);
    try {
      const result = await handler();
      return await this.jobs.markSucceeded(running.id, result);
    } catch (error) {
      return await this.jobs.markFailed(
        running.id,
        error instanceof Error ? error.message : 'job failed',
      );
    }
  }
}
