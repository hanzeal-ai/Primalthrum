import { OtlpHttpTraceExporter } from '../services/otlpHttpTraceExporter';

const endpoint = requiredEnvironment('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT');
const startTimeUnixNano = (BigInt(Date.now()) * 1_000_000n).toString();
const endTimeUnixNano = (BigInt(startTimeUnixNano) + 1_000_000n).toString();

async function main(): Promise<void> {
  const serverExporter = exporter('primalthrum-server-smoke');
  serverExporter.record({
    traceId: '11111111111111111111111111111111',
    spanId: '1111111111111111',
    traceFlags: '01',
    name: 'GET /healthz',
    method: 'GET',
    route: '/healthz',
    statusCode: 200,
    startTimeUnixNano,
    endTimeUnixNano,
  });
  await serverExporter.shutdown();

  const workerExporter = exporter('primalthrum-worker-smoke');
  workerExporter.record({
    traceId: '22222222222222222222222222222222',
    spanId: '2222222222222222',
    traceFlags: '01',
    name: 'primalthrum.worker.durable_job.process',
    queue: 'durable_job',
    operation: 'process',
    outcome: 'succeeded',
    attempt: 1,
    messageId: 'smoke-job',
    startTimeUnixNano,
    endTimeUnixNano,
  });
  await workerExporter.shutdown();
}

function exporter(serviceName: string): OtlpHttpTraceExporter {
  return new OtlpHttpTraceExporter({
    endpoint,
    serviceName,
    serviceVersion: 'smoke',
    deploymentEnvironment: 'production-smoke',
    flushIntervalMs: 10,
  });
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'OTLP collector smoke failed'}\n`);
  process.exitCode = 1;
});
