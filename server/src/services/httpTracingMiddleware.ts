import { type Middleware } from 'koa';

import { type HttpServerTraceSpan, type HttpTraceExporter } from './httpTraceExporter';
import { createServerTraceContext, formatTraceparent } from './traceContext';

export function createHttpTracingMiddleware(exporter: HttpTraceExporter): Middleware {
  return async (ctx, next) => {
    const trace = createServerTraceContext(ctx.get('traceparent'));
    const startTimeUnixNano = BigInt(Date.now()) * 1_000_000n;
    const startedAt = process.hrtime.bigint();
    let requestError: unknown;
    ctx.state.traceId = trace.traceId;
    ctx.state.spanId = trace.spanId;
    ctx.set('traceparent', formatTraceparent(trace));
    ctx.set('x-request-id', trace.traceId);
    try {
      await next();
    } catch (error) {
      requestError = error;
      throw error;
    } finally {
      if (trace.sampled) {
        const route = matchedRoute(ctx);
        const span: HttpServerTraceSpan = {
          traceId: trace.traceId,
          spanId: trace.spanId,
          traceFlags: trace.traceFlags,
          ...(trace.parentSpanId ? { parentSpanId: trace.parentSpanId } : {}),
          name: `${ctx.method} ${route}`,
          method: ctx.method,
          route,
          statusCode: requestError ? 500 : ctx.status,
          startTimeUnixNano: startTimeUnixNano.toString(),
          endTimeUnixNano: (startTimeUnixNano + (process.hrtime.bigint() - startedAt)).toString(),
          ...(requestError
            ? { errorType: requestError instanceof Error ? requestError.name : 'Error' }
            : {}),
        };
        exporter.record(span);
      }
    }
  };
}

function matchedRoute(ctx: Parameters<Middleware>[0]): string {
  const route = (ctx as typeof ctx & { _matchedRoute?: unknown })._matchedRoute;
  return typeof route === 'string' && route ? route : 'unmatched';
}
