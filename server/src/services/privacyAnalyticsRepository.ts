import { randomUUID } from 'node:crypto';

import { type DatabaseAdapter } from '../db/adapter';
import { sqlValue } from '../db/sql';

import {
  type PrivacyAnalyticsStore,
  PRIVACY_POLICY_VERSION,
  type RecordAnalyticsEventInput,
  type RecordConsentInput,
} from './privacyAnalyticsStore';
import {
  type AnalyticsRow,
  type ConsentRow,
  hashPrivacySubject,
  mapAnalyticsEvent,
  mapConsentReceipt,
  sameAnalyticsEvent,
} from './privacyAnalyticsShared';

export class PrivacyAnalyticsRepository implements PrivacyAnalyticsStore {
  constructor(private readonly db: DatabaseAdapter) {
  }

  recordConsent(input: RecordConsentInput) {
    const subjectHash = hashPrivacySubject(input.subjectId);
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
    return mapConsentReceipt(receipt);
  }

  recordEvent(input: RecordAnalyticsEventInput) {
    const subjectHash = hashPrivacySubject(input.subjectId);
    if (!this.hasCurrentGrant(subjectHash, input.consentReceiptId)) return null;
    const existing = this.findEvent(input.eventId);
    if (existing) {
      if (!sameEvent(existing, input, subjectHash)) {
        throw new Error('analytics event idempotency conflict');
      }
      return { ...mapAnalyticsEvent(existing), duplicate: true };
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
    return created ? { ...mapAnalyticsEvent(created), duplicate: false } : null;
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

function sameEvent(
  row: AnalyticsRow,
  input: RecordAnalyticsEventInput,
  subjectHash: string,
): boolean {
  return sameAnalyticsEvent(row, input, subjectHash);
}
