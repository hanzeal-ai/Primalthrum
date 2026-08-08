import Router from '@koa/router';

import { sendApiError } from '../services/apiErrors';
import { type AccountEmailOutboxStore } from '../services/accountEmailOutboxStore';
import { type AccountEmailWebhookVerifier } from '../services/accountEmailWebhook';
import { type StructuredLogger } from '../services/logger';
import { type MetricsRegistry } from '../services/metricsRegistry';

export function registerAccountEmailRoutes(
  router: Router,
  options: {
    outbox: AccountEmailOutboxStore;
    verifier?: AccountEmailWebhookVerifier;
    logger: StructuredLogger;
    metrics: MetricsRegistry;
  },
): void {
  router.post('/api/webhooks/email', async (ctx) => {
    if (!options.verifier) {
      sendApiError(ctx, options.logger, {
        status: 503,
        code: 'WEBHOOK_NOT_CONFIGURED',
        message: 'transactional email webhook is not configured',
      });
      return;
    }
    try {
      const rawBody = String((ctx.request as typeof ctx.request & { rawBody?: string }).rawBody ?? '');
      const event = options.verifier.verify(rawBody, ctx.headers);
      const result = await options.outbox.recordProviderEvent(event);
      if (!result.duplicate) options.metrics.observeAccountEmail(event.eventType);
      options.logger.log({
        level: ['bounced', 'complained', 'rejected'].includes(event.eventType) ? 'warn' : 'info',
        code: `ACCOUNT_EMAIL_${event.eventType.toUpperCase()}`,
        message: `account email provider reported ${event.eventType}`,
        context: {
          provider: event.provider,
          providerEventId: event.providerEventId,
          providerMessageId: event.providerMessageId,
          matched: result.matched,
          duplicate: result.duplicate,
        },
      });
      ctx.body = { received: true, matched: result.matched, duplicate: result.duplicate };
    } catch (error) {
      sendApiError(ctx, options.logger, {
        status: 400,
        code: 'WEBHOOK_SIGNATURE_INVALID',
        message: error instanceof Error ? error.message : 'email webhook is invalid',
      });
    }
  });
}
