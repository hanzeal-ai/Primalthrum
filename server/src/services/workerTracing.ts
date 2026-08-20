import { createServerTraceContext } from './traceContext';
import {
  type WorkerQueueName,
  type WorkerTraceExporter,
  type WorkerTraceSpan,
} from './workerTraceExporter';

interface WorkerTraceOperation {
  attempt: number;
  messageId: string;
  operation: string;
  queue: WorkerQueueName;
}

export async function traceWorkerOperation<Result>(
  exporter: WorkerTraceExporter | undefined,
  input: WorkerTraceOperation,
  operation: () => Promise<Result> | Result,
): Promise<Result> {
  if (!exporter) return operation();
  const trace = createServerTraceContext();
  const startTimeUnixNano = BigInt(Date.now()) * 1_000_000n;
  const startedAt = process.hrtime.bigint();
  try {
    const result = await operation();
    recordWorkerSpan(exporter, {
      ...baseSpan(input, trace, startTimeUnixNano, startedAt),
      outcome: 'succeeded',
    });
    return result;
  } catch (error) {
    recordWorkerSpan(exporter, {
      ...baseSpan(input, trace, startTimeUnixNano, startedAt),
      outcome: 'failed',
      errorType: error instanceof Error ? error.name : 'Error',
    });
    throw error;
  }
}

function baseSpan(
  input: WorkerTraceOperation,
  trace: ReturnType<typeof createServerTraceContext>,
  startTimeUnixNano: bigint,
  startedAt: bigint,
): Omit<WorkerTraceSpan, 'errorType' | 'outcome'> {
  return {
    ...input,
    name: `${input.queue} ${input.operation}`,
    traceId: trace.traceId,
    spanId: trace.spanId,
    traceFlags: trace.traceFlags,
    startTimeUnixNano: startTimeUnixNano.toString(),
    endTimeUnixNano: (startTimeUnixNano + (process.hrtime.bigint() - startedAt)).toString(),
  };
}

function recordWorkerSpan(exporter: WorkerTraceExporter, span: WorkerTraceSpan): void {
  try {
    exporter.record(span);
  } catch {
    // Telemetry must never change durable delivery state.
  }
}
