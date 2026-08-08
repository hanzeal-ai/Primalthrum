import Router from '@koa/router';
import type Koa from 'koa';

import { OperatorBillingReadRepository } from '../services/operatorBillingReadRepository';
import { OperatorCustomerReadRepository } from '../services/operatorCustomerReadRepository';
import { OperatorRuntimeReadRepository } from '../services/operatorRuntimeReadRepository';
import { OperatorSecurityReadRepository } from '../services/operatorSecurityReadRepository';
import {
  operatorError,
  requireOperator,
  type OperatorRouteSecurityOptions,
} from './operatorRoutes';

interface OperatorDomainRouteOptions extends OperatorRouteSecurityOptions {
  billingReads: OperatorBillingReadRepository;
  customerReads: OperatorCustomerReadRepository;
  runtimeReads: OperatorRuntimeReadRepository;
  securityReads: OperatorSecurityReadRepository;
}

export function registerOperatorDomainRoutes(
  router: Router,
  options: OperatorDomainRouteOptions,
): void {
  router.get('/api/operator/customer-users', async (ctx) => {
    const authenticated = await requireOperator(ctx, options, 'customer_users.read');
    if (!authenticated) return;
    const workspaceId = queryWorkspaceId(ctx, options);
    if (workspaceId === null) return;
    const users = await options.customerReads.listUsers(
      workspaceId,
      queryLimit(ctx.query.limit),
    );
    await auditRead(options, authenticated.user.id, 'operator.customer_users_read', 'customer_user', users.length);
    ctx.body = users;
  });

  router.get('/api/operator/subscriptions', async (ctx) => {
    const authenticated = await requireOperator(ctx, options, 'billing.read');
    if (!authenticated) return;
    const workspaceId = queryWorkspaceId(ctx, options);
    if (workspaceId === null) return;
    const subscriptions = await options.billingReads.listSubscriptions(
      workspaceId,
      queryLimit(ctx.query.limit),
    );
    await auditRead(options, authenticated.user.id, 'operator.subscriptions_read', 'subscription', subscriptions.length);
    ctx.body = subscriptions;
  });

  router.get('/api/operator/usage', async (ctx) => {
    const authenticated = await requireOperator(ctx, options, 'billing.read');
    if (!authenticated) return;
    const workspaceId = queryWorkspaceId(ctx, options);
    if (workspaceId === null) return;
    const usage = await options.billingReads.listUsage(
      workspaceId,
      queryLimit(ctx.query.limit),
    );
    await auditRead(options, authenticated.user.id, 'operator.usage_read', 'usage', usage.length);
    ctx.body = usage;
  });

  router.get('/api/operator/payments', async (ctx) => {
    const authenticated = await requireOperator(ctx, options, 'billing.read');
    if (!authenticated) return;
    const workspaceId = queryWorkspaceId(ctx, options);
    if (workspaceId === null) return;
    const payments = await options.billingReads.listPayments(
      workspaceId,
      queryLimit(ctx.query.limit),
    );
    const count = payments.invoices.length
      + payments.refunds.length
      + payments.webhookFailures.length;
    await auditRead(options, authenticated.user.id, 'operator.payments_read', 'payment', count);
    ctx.body = payments;
  });

  router.get('/api/operator/agents', async (ctx) => {
    const authenticated = await requireOperator(ctx, options, 'agents.read');
    if (!authenticated) return;
    const workspaceId = queryWorkspaceId(ctx, options);
    if (workspaceId === null) return;
    const agents = await options.runtimeReads.listAgents(
      workspaceId,
      queryLimit(ctx.query.limit),
    );
    await auditRead(options, authenticated.user.id, 'operator.agents_read', 'agent', agents.length);
    ctx.body = agents;
  });

  router.get('/api/operator/jobs', async (ctx) => {
    const authenticated = await requireOperator(ctx, options, 'jobs.read');
    if (!authenticated) return;
    const workspaceId = queryWorkspaceId(ctx, options);
    if (workspaceId === null) return;
    const jobs = await options.runtimeReads.listJobs(
      workspaceId,
      queryLimit(ctx.query.limit),
    );
    await auditRead(options, authenticated.user.id, 'operator.jobs_read', 'job', jobs.length);
    ctx.body = jobs;
  });

  router.get('/api/operator/abuse-events', async (ctx) => {
    const authenticated = await requireOperator(ctx, options, 'abuse.read');
    if (!authenticated) return;
    const events = await options.securityReads.listAbuseEvents(queryLimit(ctx.query.limit));
    await auditRead(options, authenticated.user.id, 'operator.abuse_events_read', 'abuse_event', events.length);
    ctx.body = events;
  });
}

function queryWorkspaceId(
  ctx: Koa.Context,
  options: OperatorRouteSecurityOptions,
): number | undefined | null {
  const candidate = Array.isArray(ctx.query.workspaceId)
    ? ctx.query.workspaceId[0]
    : ctx.query.workspaceId;
  if (candidate === undefined || candidate === '') return undefined;
  const parsed = Number(candidate);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    operatorError(ctx, options.logger, 400, 'OPERATOR_WORKSPACE_FILTER_INVALID', 'workspace filter is invalid');
    return null;
  }
  return parsed;
}

function queryLimit(value: unknown): number {
  const candidate = Array.isArray(value) ? value[0] : value;
  const parsed = Number(candidate ?? 100);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 200) : 100;
}

async function auditRead(
  options: OperatorRouteSecurityOptions,
  operatorUserId: number,
  eventType: string,
  targetType: string,
  count: number,
): Promise<void> {
  await options.audit.record({
    operatorUserId,
    eventType,
    targetType,
    metadata: { count },
  });
}
