import Router from '@koa/router';

import { sendApiError } from '../services/apiErrors';
import { type StructuredLogger } from '../services/logger';
import {
  ANALYTICS_EVENT_NAMES,
  PRIVACY_POLICY_VERSION,
  PrivacyAnalyticsRepository,
  type AnalyticsEventName,
  type ConsentSource,
} from '../services/privacyAnalyticsRepository';

const OPAQUE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROPERTY_KEYS = new Set(['source', 'planKey', 'authenticated']);

export function registerPrivacyRoutes(
  router: Router,
  options: { analytics: PrivacyAnalyticsRepository; logger: StructuredLogger },
): void {
  router.get('/api/public/privacy/config', (ctx) => {
    ctx.body = {
      policyVersion: PRIVACY_POLICY_VERSION,
      categories: {
        necessary: { required: true },
        analytics: { required: false, default: false },
      },
    };
  });

  router.post('/api/public/privacy/consents', (ctx) => {
    try {
      const body = ctx.request.body as Record<string, unknown>;
      const subjectId = opaqueId(body.subjectId, 'subjectId');
      const analytics = requiredBoolean(body.analytics, 'analytics');
      const source = consentSource(body.source);
      if (body.policyVersion !== PRIVACY_POLICY_VERSION) {
        throw new Error('the current privacy policy version is required');
      }
      ctx.status = 201;
      ctx.body = options.analytics.recordConsent({
        subjectId,
        analytics,
        source,
        policyVersion: PRIVACY_POLICY_VERSION,
      });
    } catch (error) {
      sendApiError(ctx, options.logger, {
        status: 400,
        code: 'PRIVACY_CONSENT_INVALID',
        message: error instanceof Error ? error.message : 'privacy consent is invalid',
      });
    }
  });

  router.post('/api/public/analytics/events', (ctx) => {
    try {
      const body = ctx.request.body as Record<string, unknown>;
      const event = options.analytics.recordEvent({
        subjectId: opaqueId(body.subjectId, 'subjectId'),
        consentReceiptId: opaqueId(body.consentReceiptId, 'consentReceiptId'),
        eventId: opaqueId(body.eventId, 'eventId'),
        eventName: eventName(body.eventName),
        path: eventPath(body.path),
        properties: eventProperties(body.properties),
        occurredAt: occurredAt(body.occurredAt),
      });
      if (!event) {
        sendApiError(ctx, options.logger, {
          status: 403,
          code: 'ANALYTICS_CONSENT_REQUIRED',
          message: 'current analytics consent is required',
        });
        return;
      }
      ctx.status = 202;
      ctx.body = { accepted: true, eventId: event.eventId, duplicate: event.duplicate };
    } catch (error) {
      sendApiError(ctx, options.logger, {
        status: error instanceof Error && error.message.includes('idempotency conflict') ? 409 : 400,
        code: 'ANALYTICS_EVENT_INVALID',
        message: error instanceof Error ? error.message : 'analytics event is invalid',
      });
    }
  });
}

function opaqueId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !OPAQUE_ID.test(value)) {
    throw new Error(`${field} must be a UUID`);
  }
  return value.toLowerCase();
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`);
  return value;
}

function consentSource(value: unknown): ConsentSource {
  if (value !== 'banner' && value !== 'preferences') {
    throw new Error('consent source is invalid');
  }
  return value;
}

function eventName(value: unknown): AnalyticsEventName {
  if (typeof value !== 'string' || !ANALYTICS_EVENT_NAMES.includes(value as AnalyticsEventName)) {
    throw new Error('analytics event name is not allowed');
  }
  return value as AnalyticsEventName;
}

function eventPath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 256) {
    throw new Error('analytics path must be a bounded application path');
  }
  return value;
}

function eventProperties(value: unknown): Record<string, string | boolean> {
  if (typeof value === 'undefined') return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('analytics properties must be an object');
  }
  const properties = value as Record<string, unknown>;
  if (Object.keys(properties).length > 3) throw new Error('too many analytics properties');
  return Object.fromEntries(Object.entries(properties).map(([key, entry]) => {
    if (!PROPERTY_KEYS.has(key)) throw new Error(`analytics property ${key} is not allowed`);
    if (key === 'authenticated' && typeof entry === 'boolean') return [key, entry];
    if (key === 'source' && typeof entry === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(entry)) {
      return [key, entry];
    }
    if (key === 'planKey' && typeof entry === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(entry)) {
      return [key, entry];
    }
    throw new Error(`analytics property ${key} has an invalid value`);
  }));
}

function occurredAt(value: unknown): string {
  if (typeof value !== 'string') throw new Error('occurredAt must be an ISO timestamp');
  const timestamp = new Date(value);
  const now = Date.now();
  if (Number.isNaN(timestamp.getTime())
    || timestamp.getTime() < now - 24 * 60 * 60 * 1000
    || timestamp.getTime() > now + 5 * 60 * 1000) {
    throw new Error('occurredAt is outside the accepted window');
  }
  return timestamp.toISOString();
}
