import { randomBytes } from 'node:crypto';

const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

export interface ServerTraceContext {
  parentSpanId?: string;
  sampled: boolean;
  spanId: string;
  traceFlags: string;
  traceId: string;
}

export function createServerTraceContext(traceparent?: string): ServerTraceContext {
  const parent = parseTraceparent(traceparent);
  const traceFlags = parent?.traceFlags ?? '01';
  return {
    traceId: parent?.traceId ?? randomNonZeroHex(16),
    spanId: randomNonZeroHex(8),
    traceFlags,
    sampled: (Number.parseInt(traceFlags, 16) & 1) === 1,
    ...(parent ? { parentSpanId: parent.spanId } : {}),
  };
}

export function formatTraceparent(context: ServerTraceContext): string {
  return `00-${context.traceId}-${context.spanId}-${context.traceFlags}`;
}

function parseTraceparent(value?: string): {
  spanId: string;
  traceFlags: string;
  traceId: string;
} | null {
  const match = value?.trim().match(TRACEPARENT_PATTERN);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  const traceId = match[1].toLowerCase();
  const spanId = match[2].toLowerCase();
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return null;
  return { traceId, spanId, traceFlags: match[3].toLowerCase() };
}

function randomNonZeroHex(bytes: number): string {
  let value = '';
  do {
    value = randomBytes(bytes).toString('hex');
  } while (/^0+$/.test(value));
  return value;
}
