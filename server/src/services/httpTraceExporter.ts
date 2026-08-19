export interface HttpServerTraceSpan {
  endTimeUnixNano: string;
  errorType?: string;
  method: string;
  name: string;
  parentSpanId?: string;
  route: string;
  spanId: string;
  startTimeUnixNano: string;
  statusCode: number;
  traceFlags: string;
  traceId: string;
}

export interface HttpTraceExporter {
  record(span: HttpServerTraceSpan): void;
  shutdown(): Promise<void>;
}
