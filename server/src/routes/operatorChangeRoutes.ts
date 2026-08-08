import Router from '@koa/router';
import type Koa from 'koa';

import { type OperatorAuditStore } from '../services/operatorAuditStore';
import { OperatorFeatureFlagRepository } from '../services/operatorFeatureFlagRepository';
import { OperatorIncidentRepository } from '../services/operatorIncidentRepository';
import { type StructuredLogger } from '../services/logger';
import { type OperatorIdentityStore } from '../services/operatorIdentityStore';
import { operatorError, requireOperator } from './operatorRoutes';

interface OperatorChangeRouteOptions {
  audit: OperatorAuditStore;
  featureFlags: OperatorFeatureFlagRepository;
  identity: OperatorIdentityStore;
  incidents: OperatorIncidentRepository;
  logger: StructuredLogger;
}

export function registerOperatorChangeRoutes(
  router: Router,
  options: OperatorChangeRouteOptions,
): void {
  router.get('/api/operator/feature-flags', async (ctx) => {
    const authenticated = await requireOperator(ctx, options, 'feature_flags.read');
    if (!authenticated) return;
    const flags = await options.featureFlags.list();
    await recordRead(options, authenticated.user.id, 'operator.feature_flags_read', 'feature_flag', flags.length);
    ctx.body = flags;
  });

  router.post('/api/operator/feature-flags', async (ctx) => {
    const authenticated = await requireOperator(ctx, options, 'feature_flags.manage');
    if (!authenticated) return;
    try {
      const body = requestBody(ctx);
      const flag = await options.featureFlags.create({
        key: body.key,
        description: body.description,
        enabled: body.enabled,
        killSwitch: body.killSwitch,
        rolloutPercentage: body.rolloutPercentage,
        operatorUserId: authenticated.user.id,
      });
      await options.audit.record({
        operatorUserId: authenticated.user.id,
        eventType: 'operator.feature_flag_created',
        targetType: 'feature_flag',
        targetId: flag.id,
        metadata: { key: flag.key, revision: flag.revision },
      });
      ctx.status = 201;
      ctx.body = flag;
    } catch (error) {
      changeRequestError(ctx, options.logger, error);
    }
  });

  router.put('/api/operator/feature-flags/:id', async (ctx) => {
    const authenticated = await requireOperator(ctx, options, 'feature_flags.manage');
    if (!authenticated) return;
    try {
      const body = requestBody(ctx);
      const flag = await options.featureFlags.update(positiveId(ctx.params.id), {
        description: body.description,
        enabled: body.enabled,
        killSwitch: body.killSwitch,
        rolloutPercentage: body.rolloutPercentage,
        expectedRevision: body.expectedRevision,
        operatorUserId: authenticated.user.id,
      });
      await options.audit.record({
        operatorUserId: authenticated.user.id,
        eventType: 'operator.feature_flag_updated',
        targetType: 'feature_flag',
        targetId: flag.id,
        metadata: {
          enabled: flag.enabled,
          killSwitch: flag.killSwitch,
          rolloutPercentage: flag.rolloutPercentage,
          revision: flag.revision,
        },
      });
      ctx.body = flag;
    } catch (error) {
      changeRequestError(ctx, options.logger, error);
    }
  });

  router.get('/api/operator/feature-flags/:id/events', async (ctx) => {
    const authenticated = await requireOperator(ctx, options, 'feature_flags.read');
    if (!authenticated) return;
    try {
      const flagId = positiveId(ctx.params.id);
      const events = await options.featureFlags.listEvents(flagId, queryLimit(ctx.query.limit));
      await recordRead(options, authenticated.user.id, 'operator.feature_flag_events_read', 'feature_flag', events.length, flagId);
      ctx.body = events;
    } catch (error) {
      changeRequestError(ctx, options.logger, error);
    }
  });

  router.post('/api/operator/feature-flags/:id/overrides', async (ctx) => {
    const authenticated = await requireOperator(ctx, options, 'feature_flags.manage');
    if (!authenticated) return;
    try {
      const flagId = positiveId(ctx.params.id);
      const body = requestBody(ctx);
      const override = await options.featureFlags.createOverride(flagId, {
        workspaceId: body.workspaceId,
        enabled: body.enabled,
        reason: body.reason,
        operatorUserId: authenticated.user.id,
      });
      await options.audit.record({
        operatorUserId: authenticated.user.id,
        eventType: 'operator.feature_flag_override_created',
        targetType: 'feature_flag_override',
        targetId: override.id,
        metadata: { flagId, workspaceId: override.workspaceId, enabled: override.enabled },
      });
      ctx.status = 201;
      ctx.body = override;
    } catch (error) {
      changeRequestError(ctx, options.logger, error);
    }
  });

  router.post('/api/operator/feature-flags/:id/overrides/:overrideId/revoke', async (ctx) => {
    const authenticated = await requireOperator(ctx, options, 'feature_flags.manage');
    if (!authenticated) return;
    try {
      const flagId = positiveId(ctx.params.id);
      const body = requestBody(ctx);
      const override = await options.featureFlags.revokeOverride(
        flagId,
        positiveId(ctx.params.overrideId),
        {
          expectedRevision: body.expectedRevision,
          operatorUserId: authenticated.user.id,
        },
      );
      await options.audit.record({
        operatorUserId: authenticated.user.id,
        eventType: 'operator.feature_flag_override_revoked',
        targetType: 'feature_flag_override',
        targetId: override.id,
        metadata: { flagId, workspaceId: override.workspaceId, revision: override.revision },
      });
      ctx.body = override;
    } catch (error) {
      changeRequestError(ctx, options.logger, error);
    }
  });

  router.get('/api/operator/incidents', async (ctx) => {
    const authenticated = await requireOperator(ctx, options, 'incidents.read');
    if (!authenticated) return;
    const incidents = await options.incidents.list(queryLimit(ctx.query.limit));
    await recordRead(options, authenticated.user.id, 'operator.incidents_read', 'incident', incidents.length);
    ctx.body = incidents;
  });

  router.get('/api/operator/incidents/:id', async (ctx) => {
    const authenticated = await requireOperator(ctx, options, 'incidents.read');
    if (!authenticated) return;
    const incident = await options.incidents.find(positiveId(ctx.params.id));
    if (!incident) {
      operatorError(ctx, options.logger, 404, 'OPERATOR_INCIDENT_NOT_FOUND', 'incident not found');
      return;
    }
    await recordRead(options, authenticated.user.id, 'operator.incident_read', 'incident', 1, incident.id);
    ctx.body = incident;
  });

  router.post('/api/operator/incidents', async (ctx) => {
    const authenticated = await requireOperator(ctx, options, 'incidents.manage');
    if (!authenticated) return;
    try {
      const body = requestBody(ctx);
      const incident = await options.incidents.create({
        title: body.title,
        severity: body.severity,
        impactScope: body.impactScope,
        workspaceId: body.workspaceId,
        summary: body.summary,
        startedAt: body.startedAt,
        ownerOperatorId: body.ownerOperatorId,
        operatorUserId: authenticated.user.id,
      });
      await options.audit.record({
        operatorUserId: authenticated.user.id,
        eventType: 'operator.incident_created',
        targetType: 'incident',
        targetId: incident.id,
        metadata: {
          incidentRef: incident.incidentRef,
          severity: incident.severity,
          impactScope: incident.impactScope,
        },
      });
      ctx.status = 201;
      ctx.body = incident;
    } catch (error) {
      changeRequestError(ctx, options.logger, error);
    }
  });

  router.put('/api/operator/incidents/:id', async (ctx) => {
    const authenticated = await requireOperator(ctx, options, 'incidents.manage');
    if (!authenticated) return;
    try {
      const body = requestBody(ctx);
      const incident = await options.incidents.update(positiveId(ctx.params.id), {
        title: body.title,
        severity: body.severity,
        status: body.status,
        impactScope: body.impactScope,
        workspaceId: body.workspaceId,
        summary: body.summary,
        ownerOperatorId: body.ownerOperatorId,
        expectedRevision: body.expectedRevision,
        operatorUserId: authenticated.user.id,
      });
      await options.audit.record({
        operatorUserId: authenticated.user.id,
        eventType: 'operator.incident_updated',
        targetType: 'incident',
        targetId: incident.id,
        metadata: {
          status: incident.status,
          severity: incident.severity,
          revision: incident.revision,
        },
      });
      ctx.body = incident;
    } catch (error) {
      changeRequestError(ctx, options.logger, error);
    }
  });

  router.post('/api/operator/incidents/:id/events', async (ctx) => {
    const authenticated = await requireOperator(ctx, options, 'incidents.manage');
    if (!authenticated) return;
    try {
      const incidentId = positiveId(ctx.params.id);
      const body = requestBody(ctx);
      const event = await options.incidents.appendEvent(incidentId, {
        eventType: body.eventType,
        message: body.message,
        operatorUserId: authenticated.user.id,
      });
      await options.audit.record({
        operatorUserId: authenticated.user.id,
        eventType: 'operator.incident_event_created',
        targetType: 'incident',
        targetId: incidentId,
        metadata: { incidentEventId: event.id, eventType: event.eventType },
      });
      ctx.status = 201;
      ctx.body = event;
    } catch (error) {
      changeRequestError(ctx, options.logger, error);
    }
  });
}

function requestBody(ctx: Koa.Context): Record<string, unknown> {
  return ctx.request.body && typeof ctx.request.body === 'object'
    ? ctx.request.body as Record<string, unknown>
    : {};
}

function positiveId(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error('identifier is invalid');
  return parsed;
}

function queryLimit(value: unknown): number {
  const candidate = Array.isArray(value) ? value[0] : value;
  const parsed = Number(candidate ?? 100);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 200) : 100;
}

async function recordRead(
  options: Pick<OperatorChangeRouteOptions, 'audit'>,
  operatorUserId: number,
  eventType: string,
  targetType: string,
  count: number,
  targetId?: number,
): Promise<void> {
  await options.audit.record({
    operatorUserId,
    eventType,
    targetType,
    targetId,
    metadata: { count },
  });
}

function changeRequestError(
  ctx: Koa.Context,
  logger: StructuredLogger,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : 'operator change request is invalid';
  if (/not found/i.test(message)) {
    operatorError(ctx, logger, 404, 'OPERATOR_CHANGE_NOT_FOUND', message);
    return;
  }
  if (/conflict|transition/i.test(message)) {
    operatorError(ctx, logger, 409, 'OPERATOR_CHANGE_CONFLICT', message);
    return;
  }
  if (/unique/i.test(message)) {
    operatorError(ctx, logger, 409, 'OPERATOR_CHANGE_CONFLICT', 'operator change record already exists');
    return;
  }
  operatorError(ctx, logger, 400, 'OPERATOR_CHANGE_INVALID', message);
}
