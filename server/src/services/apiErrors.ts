import Koa from 'koa';

import { type StructuredLogger } from './logger';

export type ErrorCode =
  | 'CONVERSATION_AGENT_NOT_FOUND'
  | 'CONVERSATION_NOT_FOUND'
  | 'DOCUMENT_AGENT_NOT_FOUND'
  | 'DOCUMENT_INVALID'
  | 'DOCUMENT_INDEX_FAILED'
  | 'DOCUMENT_NOT_FOUND'
  | 'JOB_NOT_FOUND'
  | 'PROVIDER_CONFIG_INVALID'
  | 'PROVIDER_CONFIG_NOT_FOUND'
  | 'RUN_AGENT_NOT_FOUND'
  | 'RUN_EVENT_INVALID'
  | 'RUN_ID_INVALID'
  | 'RUN_INVALID'
  | 'RUN_NOT_FOUND';

export interface ApiErrorPayload {
  error: {
    code: ErrorCode;
    message: string;
    status: number;
    details?: Record<string, unknown>;
  };
}

export function sendApiError(
  ctx: Koa.Context,
  logger: StructuredLogger,
  input: {
    status: number;
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  },
): void {
  ctx.status = input.status;
  ctx.body = buildApiError(input);
  logger.log({
    level: input.status >= 500 ? 'error' : 'warn',
    code: input.code,
    message: input.message,
    context: {
      method: ctx.method,
      path: ctx.path,
      status: input.status,
      ...(input.details ? { details: input.details } : {}),
    },
  });
}

export function buildApiError(input: {
  status: number;
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}): ApiErrorPayload {
  return {
    error: {
      code: input.code,
      message: input.message,
      status: input.status,
      ...(input.details ? { details: input.details } : {}),
    },
  };
}
