import Router from '@koa/router';
import type Koa from 'koa';

import { type StructuredLogger } from '../services/logger';
import { OperatorAuditRepository } from '../services/operatorAuditRepository';
import { OperatorIdentityRepository } from '../services/operatorIdentityRepository';
import {
  WorkspaceLegalHoldError,
  WorkspaceLegalHoldRepository,
} from '../services/workspaceLegalHoldRepository';
import { operatorError, requireOperator } from './operatorRoutes';

interface OperatorLegalHoldRouteOptions {
  audit: OperatorAuditRepository;
  identity: OperatorIdentityRepository;
  legalHolds: WorkspaceLegalHoldRepository;
  logger: StructuredLogger;
}

export function registerOperatorLegalHoldRoutes(
  router: Router,
  options: OperatorLegalHoldRouteOptions,
): void {
  router.get('/api/operator/legal-holds', (ctx) => {
    const authenticated = requireOperator(ctx, options, 'legal_holds.read');
    if (!authenticated) return;
    const holds = options.legalHolds.list(queryLimit(ctx.query.limit));
    options.audit.record({
      operatorUserId: authenticated.user.id,
      eventType: 'operator.legal_holds_read',
      targetType: 'legal_hold',
      metadata: { count: holds.length },
    });
    ctx.body = holds;
  });

  router.post('/api/operator/legal-holds', (ctx) => {
    const authenticated = requireOperator(ctx, options, 'legal_holds.manage');
    if (!authenticated) return;
    try {
      const body = requestBody(ctx);
      const hold = options.legalHolds.create({
        workspaceId: body.workspaceId,
        externalCaseRef: body.externalCaseRef,
        basis: body.basis,
        reason: body.reason,
        operatorUserId: authenticated.user.id,
      });
      options.audit.record({
        operatorUserId: authenticated.user.id,
        eventType: 'operator.legal_hold_placed',
        targetType: 'legal_hold',
        targetId: hold.id,
        metadata: {
          workspaceId: hold.workspaceId,
          basis: hold.basis,
          revision: hold.revision,
        },
      });
      ctx.status = 201;
      ctx.body = hold;
    } catch (error) {
      legalHoldRequestError(ctx, options.logger, error);
    }
  });

  router.post('/api/operator/legal-holds/:id/release', (ctx) => {
    const authenticated = requireOperator(ctx, options, 'legal_holds.manage');
    if (!authenticated) return;
    try {
      const body = requestBody(ctx);
      const hold = options.legalHolds.release(ctx.params.id, {
        expectedRevision: body.expectedRevision,
        releaseReason: body.releaseReason,
        operatorUserId: authenticated.user.id,
      });
      options.audit.record({
        operatorUserId: authenticated.user.id,
        eventType: 'operator.legal_hold_released',
        targetType: 'legal_hold',
        targetId: hold.id,
        metadata: {
          workspaceId: hold.workspaceId,
          basis: hold.basis,
          revision: hold.revision,
        },
      });
      ctx.body = hold;
    } catch (error) {
      legalHoldRequestError(ctx, options.logger, error);
    }
  });
}

function requestBody(ctx: Koa.Context): Record<string, unknown> {
  return ctx.request.body && typeof ctx.request.body === 'object'
    ? ctx.request.body as Record<string, unknown>
    : {};
}

function queryLimit(value: unknown): number {
  const candidate = Array.isArray(value) ? value[0] : value;
  const parsed = Number(candidate ?? 100);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 200) : 100;
}

function legalHoldRequestError(
  ctx: Koa.Context,
  logger: StructuredLogger,
  error: unknown,
): void {
  if (error instanceof WorkspaceLegalHoldError) {
    const status = error.code === 'NOT_FOUND'
      ? 404
      : error.code === 'REVISION_CONFLICT' || error.code === 'SELF_RELEASE_FORBIDDEN'
        ? 409
        : 400;
    operatorError(ctx, logger, status, `OPERATOR_LEGAL_HOLD_${error.code}`, error.message);
    return;
  }
  operatorError(
    ctx,
    logger,
    500,
    'OPERATOR_LEGAL_HOLD_FAILED',
    'legal hold operation failed',
  );
}
