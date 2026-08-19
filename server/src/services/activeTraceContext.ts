import { AsyncLocalStorage } from 'node:async_hooks';

import { formatTraceparent, type ServerTraceContext } from './traceContext';

const traceContextStorage = new AsyncLocalStorage<ServerTraceContext>();

export function runWithActiveTraceContext<Result>(
  context: ServerTraceContext,
  operation: () => Result,
): Result {
  return traceContextStorage.run(context, operation);
}

export function activeTraceparent(): string | undefined {
  const context = traceContextStorage.getStore();
  return context ? formatTraceparent(context) : undefined;
}
