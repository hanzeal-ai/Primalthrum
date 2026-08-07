import { createHash, randomUUID } from 'node:crypto';

import { type DatabaseAdapter } from '../db/adapter';
import { sqlValue } from '../db/sql';

export const PRIVACY_POLICY_VERSION = '2026-07-31';

export const ANALYTICS_EVENT_NAMES = [
  'page_view',
  'agent_intent_started',
  'plan_selected',
  'signup_viewed',
  'signup_submitted',
  'signup_completed',
  'email_verification_completed',
] as const;

export type AnalyticsEventName = typeof ANALYTICS_EVENT_NAMES[number];
export type ConsentSource = 'banner' | 'preferences';

export interface ConsentReceipt {
  receiptId: string;
  policyVersion: string;
  necessary: true;
  analytics: boolean;
  action: 'granted' | 'denied' | 'withdrawn';
  recordedAt: string;
}

export interface ProductAnalyticsEvent {
  id: number;
  eventId: string;
  eventName: AnalyticsEventName;
  path: string;
  properties: Record<string, string | boolean>;
  occurredAt: string;
  duplicate: boolean;
}

interface ConsentRow {
  id: number;
  receipt_id: string;
  policy_version: string;
  analytics_granted: number;
  action: ConsentReceipt['action'];
  created_at: string;
}

interface AnalyticsRow {
  id: number;
  event_id: string;
  consent_receipt_ref: string;
  subject_hash: string;
  event_name: AnalyticsEventName;
  path: string;
  properties_json: string;
  occurred_at: string;
}

export class PrivacyAnalyticsRepository {
  constructor(private readonly db: DatabaseAdapter) {
  }

  recordConsent(input: {
    subjectId: string;
    analytics: boolean;
    source: ConsentSource;
    policyVersion?: string;
  }): ConsentReceipt {
    const subjectHash = hashSubject(input.subjectId);
    const receiptId = randomUUID();
    const policyVersion = input.policyVersion ?? PRIVACY_POLICY_VERSION;
    this.db.run(`
      INSERT INTO privacy_consent_receipts (
        receipt_id, subject_hash, policy_version, analytics_granted, action, source
      ) VALUES (
        ${sqlValue(receiptId)}, ${sqlValue(subjectHash)}, ${sqlValue(policyVersion)},
        ${sqlValue(input.analytics)},
        CASE
          WHEN ${sqlValue(input.analytics)} = 1 THEN 'granted'
          WHEN COALESCE((
            SELECT analytics_granted FROM privacy_consent_receipts
            WHERE subject_hash = ${sqlValue(subjectHash)} ORDER BY id DESC LIMIT 1
          ), 0) = 1 THEN 'withdrawn'
          ELSE 'denied'
        END,
        ${sqlValue(input.source)}
      );
    `);
    const receipt = this.findReceipt(receiptId);
    if (!receipt) throw new Error('privacy consent receipt could not be loaded');
    return mapConsent(receipt);
  }

  recordEvent(input: {
    subjectId: string;
    consentReceiptId: string;
    eventId: string;
    eventName: AnalyticsEventName;
    path: string;
    properties: Record<string, string | boolean>;
    occurredAt: string;
  }): ProductAnalyticsEvent | null {
    const subjectHash = hashSubject(input.subjectId);
    if (!this.hasCurrentGrant(subjectHash, input.consentReceiptId)) return null;
    const existing = this.findEvent(input.eventId);
    if (existing) {
      if (!sameEvent(existing, input, subjectHash)) {
        throw new Error('analytics event idempotency conflict');
      }
      return { ...mapEvent(existing), duplicate: true };
    }

    const created = this.db.query<AnalyticsRow>(`
      INSERT INTO product_analytics_events (
        event_id, consent_receipt_id, subject_hash, event_name,
        path, properties_json, occurred_at
      )
      SELECT
        ${sqlValue(input.eventId)}, consent.id, ${sqlValue(subjectHash)},
        ${sqlValue(input.eventName)}, ${sqlValue(input.path)},
        ${sqlValue(JSON.stringify(input.properties))}, ${sqlValue(input.occurredAt)}
      FROM privacy_consent_receipts consent
      WHERE consent.receipt_id = ${sqlValue(input.consentReceiptId)}
        AND consent.subject_hash = ${sqlValue(subjectHash)}
        AND consent.analytics_granted = 1
        AND consent.id = (
          SELECT MAX(latest.id) FROM privacy_consent_receipts latest
          WHERE latest.subject_hash = ${sqlValue(subjectHash)}
        )
      RETURNING id, event_id, ${sqlValue(input.consentReceiptId)} AS consent_receipt_ref,
        subject_hash, event_name, path, properties_json, occurred_at;
    `)[0];
    return created ? { ...mapEvent(created), duplicate: false } : null;
  }

  private findReceipt(receiptId: string): ConsentRow | null {
    return this.db.query<ConsentRow>(`
      SELECT id, receipt_id, policy_version, analytics_granted, action, created_at
      FROM privacy_consent_receipts WHERE receipt_id = ${sqlValue(receiptId)} LIMIT 1;
    `)[0] ?? null;
  }

  private hasCurrentGrant(subjectHash: string, receiptId: string): boolean {
    return Boolean(this.db.query<{ id: number }>(`
      SELECT id FROM privacy_consent_receipts
      WHERE receipt_id = ${sqlValue(receiptId)}
        AND subject_hash = ${sqlValue(subjectHash)}
        AND analytics_granted = 1
        AND id = (
          SELECT MAX(latest.id) FROM privacy_consent_receipts latest
          WHERE latest.subject_hash = ${sqlValue(subjectHash)}
        )
      LIMIT 1;
    `)[0]);
  }

  private findEvent(eventId: string): AnalyticsRow | null {
    return this.db.query<AnalyticsRow>(`
      SELECT events.id, events.event_id, consent.receipt_id AS consent_receipt_ref,
        events.subject_hash, events.event_name, events.path, events.properties_json,
        events.occurred_at
      FROM product_analytics_events events
      JOIN privacy_consent_receipts consent ON consent.id = events.consent_receipt_id
      WHERE events.event_id = ${sqlValue(eventId)} LIMIT 1;
    `)[0] ?? null;
  }
}

function hashSubject(subjectId: string): string {
  return createHash('sha256').update(`primalthrum-consent:${subjectId}`).digest('hex');
}

function mapConsent(row: ConsentRow): ConsentReceipt {
  return {
    receiptId: row.receipt_id,
    policyVersion: row.policy_version,
    necessary: true,
    analytics: Boolean(row.analytics_granted),
    action: row.action,
    recordedAt: row.created_at,
  };
}

function mapEvent(row: AnalyticsRow): Omit<ProductAnalyticsEvent, 'duplicate'> {
  return {
    id: Number(row.id),
    eventId: row.event_id,
    eventName: row.event_name,
    path: row.path,
    properties: JSON.parse(row.properties_json) as Record<string, string | boolean>,
    occurredAt: row.occurred_at,
  };
}

function sameEvent(
  row: AnalyticsRow,
  input: {
    consentReceiptId: string;
    eventName: AnalyticsEventName;
    path: string;
    properties: Record<string, string | boolean>;
    occurredAt: string;
  },
  subjectHash: string,
): boolean {
  return row.consent_receipt_ref === input.consentReceiptId
    && row.subject_hash === subjectHash
    && row.event_name === input.eventName
    && row.path === input.path
    && row.properties_json === JSON.stringify(input.properties)
    && row.occurred_at === input.occurredAt;
}
