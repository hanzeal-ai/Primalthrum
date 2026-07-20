import { JobRepository, type JobRecord } from './jobRepository';

export class InProcessJobWorker {
  constructor(private readonly jobs: JobRepository) {}

  run(
    jobId: number,
    handler: () => Record<string, unknown>,
  ): JobRecord {
    const running = this.jobs.markRunning(jobId);
    try {
      const result = handler();
      return this.jobs.markSucceeded(running.id, result);
    } catch (error) {
      return this.jobs.markFailed(
        running.id,
        error instanceof Error ? error.message : 'job failed',
      );
    }
  }
}
