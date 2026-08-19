import { JsonConsoleLogger, type StructuredLogger } from './logger';
import { type HttpServerTraceSpan, type HttpTraceExporter } from './httpTraceExporter';

type FetchLike = typeof fetch;

export interface OtlpHttpTraceExporterOptions {
  deploymentEnvironment?: string;
  endpoint: string;
  fetchImpl?: FetchLike;
  flushIntervalMs?: number;
  headers?: Record<string, string>;
  logger?: StructuredLogger;
  maxBatchSize?: number;
  maxQueueSize?: number;
  serviceName: string;
  serviceVersion?: string;
  timeoutMs?: number;
}

export class OtlpHttpTraceExporter implements HttpTraceExporter {
  private readonly endpoint: string;
  private readonly fetchImpl: FetchLike;
  private readonly flushIntervalMs: number;
  private readonly headers: Record<string, string>;
  private readonly logger: StructuredLogger;
  private readonly maxBatchSize: number;
  private readonly maxQueueSize: number;
  private readonly resourceAttributes: Record<string, string>;
  private readonly timeoutMs: number;
  private accepting = true;
  private activeFlush: Promise<void> | undefined;
  private flushTimer: NodeJS.Timeout | undefined;
  private queue: HttpServerTraceSpan[] = [];

  constructor(options: OtlpHttpTraceExporterOptions) {
    this.endpoint = validatedEndpoint(options.endpoint);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.flushIntervalMs = boundedInteger(options.flushIntervalMs ?? 1_000, 10, 60_000, 'flush interval');
    this.maxBatchSize = boundedInteger(options.maxBatchSize ?? 64, 1, 512, 'batch size');
    this.maxQueueSize = boundedInteger(options.maxQueueSize ?? 2_048, this.maxBatchSize, 65_536, 'queue size');
    this.timeoutMs = boundedInteger(options.timeoutMs ?? 5_000, 100, 60_000, 'export timeout');
    this.headers = { ...(options.headers ?? {}), 'content-type': 'application/json' };
    this.logger = options.logger ?? new JsonConsoleLogger();
    this.resourceAttributes = {
      'service.name': options.serviceName,
      ...(options.serviceVersion ? { 'service.version': options.serviceVersion } : {}),
      ...(options.deploymentEnvironment
        ? { 'deployment.environment.name': options.deploymentEnvironment }
        : {}),
    };
  }

  record(span: HttpServerTraceSpan): void {
    if (!this.accepting) return;
    if (this.queue.length >= this.maxQueueSize) {
      this.queue.shift();
      this.logger.log({
        level: 'warn',
        code: 'OTLP_TRACE_QUEUE_OVERFLOW',
        message: 'Oldest queued trace span was dropped',
        context: { maxQueueSize: this.maxQueueSize },
      });
    }
    this.queue.push(span);
    if (this.queue.length >= this.maxBatchSize) {
      this.kick();
      return;
    }
    this.schedule();
  }

  async shutdown(): Promise<void> {
    this.accepting = false;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    await this.activeFlush;
    while (this.queue.length) {
      await this.sendNextBatch();
    }
  }

  private schedule(): void {
    if (this.flushTimer || this.activeFlush) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.kick();
    }, this.flushIntervalMs);
    this.flushTimer.unref();
  }

  private kick(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.activeFlush || !this.queue.length) return;
    const flush = this.sendNextBatch().finally(() => {
      if (this.activeFlush === flush) this.activeFlush = undefined;
      if (this.queue.length && this.accepting) this.schedule();
    });
    this.activeFlush = flush;
    void flush.catch(() => undefined);
  }

  private async sendNextBatch(): Promise<void> {
    const spans = this.queue.splice(0, this.maxBatchSize);
    if (!spans.length) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref();
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(otlpPayload(spans, this.resourceAttributes)),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`OTLP collector returned HTTP ${response.status}`);
      await response.body?.cancel();
    } catch (error) {
      this.logger.log({
        level: 'warn',
        code: 'OTLP_TRACE_EXPORT_FAILED',
        message: error instanceof Error ? error.message : 'OTLP trace export failed',
        context: { spanCount: spans.length },
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

function otlpPayload(
  spans: HttpServerTraceSpan[],
  resourceAttributes: Record<string, string>,
): Record<string, unknown> {
  return {
    resourceSpans: [{
      resource: { attributes: stringAttributes(resourceAttributes) },
      scopeSpans: [{
        scope: { name: 'primalthrum.http.server' },
        spans: spans.map((span) => ({
          traceId: span.traceId,
          spanId: span.spanId,
          ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
          flags: Number.parseInt(span.traceFlags, 16),
          name: span.name,
          kind: 2,
          startTimeUnixNano: span.startTimeUnixNano,
          endTimeUnixNano: span.endTimeUnixNano,
          attributes: [
            ...stringAttributes({
              'http.request.method': span.method,
              'http.route': span.route,
              ...(span.errorType ? { 'error.type': span.errorType } : {}),
            }),
            {
              key: 'http.response.status_code',
              value: { intValue: String(span.statusCode) },
            },
          ],
          status: { code: span.statusCode >= 500 || span.errorType ? 2 : 1 },
        })),
      }],
    }],
  };
}

function stringAttributes(attributes: Record<string, string>) {
  return Object.entries(attributes).map(([key, value]) => ({
    key,
    value: { stringValue: value },
  }));
}

function validatedEndpoint(value: string): string {
  const endpoint = new URL(value);
  if (!['http:', 'https:'].includes(endpoint.protocol)) {
    throw new Error('OTLP traces endpoint must use http or https');
  }
  if (endpoint.username || endpoint.password) {
    throw new Error('OTLP traces endpoint must not contain credentials');
  }
  return endpoint.toString();
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`OTLP ${name} is invalid`);
  }
  return value;
}
