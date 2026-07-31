import Koa from 'koa';

import { type StructuredLogger } from './logger';

export type ErrorCode =
  | 'ACCOUNT_ALREADY_EXISTS'
  | 'API_KEY_INVALID'
  | 'API_KEY_NOT_FOUND'
  | 'API_KEY_SCOPE_FORBIDDEN'
  | 'ANALYTICS_CONSENT_REQUIRED'
  | 'ANALYTICS_EVENT_INVALID'
  | 'AUTHORIZATION_FORBIDDEN'
  | 'AUTHENTICATION_REQUIRED'
  | 'BOT_CHALLENGE_REQUIRED'
  | 'BOT_CHALLENGE_UNAVAILABLE'
  | 'CAPABILITY_CATALOG_UNAVAILABLE'
  | 'CAPABILITY_DISABLED'
  | 'CAPABILITY_NOT_FOUND'
  | 'CAPABILITY_SETTING_INVALID'
  | 'CAPABILITY_UNAVAILABLE'
  | 'CREDIT_LIMIT_EXCEEDED'
  | 'ENTITLEMENT_LIMIT_EXCEEDED'
  | 'ENTITLEMENT_REQUIRED'
  | 'CONVERSATION_AGENT_NOT_FOUND'
  | 'CONVERSATION_NOT_FOUND'
  | 'DOCUMENT_AGENT_NOT_FOUND'
  | 'DOCUMENT_INVALID'
  | 'DOCUMENT_INDEX_FAILED'
  | 'DOCUMENT_NOT_FOUND'
  | 'EMAIL_VERIFICATION_INVALID'
  | 'AGENT_AUDIENCE_INVALID'
  | 'AGENT_NOT_FOUND'
  | 'AGENT_VERSION_INVALID'
  | 'JOB_NOT_FOUND'
  | 'PAYMENT_CHECKOUT_INVALID'
  | 'PAYMENT_PRICE_NOT_CONFIGURED'
  | 'PAYMENT_PROVIDER_FAILED'
  | 'PAYMENT_PROVIDER_UNAVAILABLE'
  | 'PAYMENT_SUBSCRIPTION_INVALID'
  | 'PASSWORD_RESET_INVALID'
  | 'PROVIDER_CONFIG_INVALID'
  | 'PROVIDER_CONFIG_NOT_FOUND'
  | 'PRIVACY_CONSENT_INVALID'
  | 'RATE_LIMIT_EXCEEDED'
  | 'REAUTHENTICATION_REQUIRED'
  | 'REGISTRATION_INVALID'
  | 'RETENTION_ENFORCEMENT_FAILED'
  | 'RETENTION_POLICY_INVALID'
  | 'RUN_AGENT_NOT_FOUND'
  | 'RUN_EVENT_INVALID'
  | 'RUN_ID_INVALID'
  | 'RUN_IDEMPOTENCY_CONFLICT'
  | 'RUN_IN_PROGRESS'
  | 'RUN_INVALID'
  | 'RUN_NOT_FOUND'
  | 'SPEECH_PROVIDER_FAILED'
  | 'SPEECH_REQUEST_INVALID'
  | 'SESSION_INVALID'
  | 'TRIAL_NOT_ELIGIBLE'
  | 'TRIAL_PLAN_INVALID'
  | 'TRIAL_REQUEST_INVALID'
  | 'USAGE_CONTROL_INVALID'
  | 'WEBHOOK_NOT_CONFIGURED'
  | 'WEBHOOK_PAYLOAD_INVALID'
  | 'WEBHOOK_PROCESSING_FAILED'
  | 'WEBHOOK_SIGNATURE_INVALID'
  | 'WORKSPACE_INVALID'
  | 'WORKSPACE_INVITATION_INVALID'
  | 'WORKSPACE_MEMBER_INVALID'
  | 'WORKSPACE_NOT_FOUND';

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
