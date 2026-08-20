export type WorkerQueueName =
  | 'account_email_outbox'
  | 'durable_job'
  | 'usage_export_outbox';

export interface WorkerTraceSpan {
  attempt: number;
  endTimeUnixNano: string;
  errorType?: string;
  messageId: string;
  name: string;
  operation: string;
  outcome: 'failed' | 'succeeded';
  queue: WorkerQueueName;
  spanId: string;
  startTimeUnixNano: string;
  traceFlags: string;
  traceId: string;
}

export interface WorkerTraceExporter {
  record(span: WorkerTraceSpan): void;
}
