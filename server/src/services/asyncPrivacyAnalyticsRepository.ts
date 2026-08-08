import { randomUUID } from 'node:crypto';

import { type AsyncDatabaseAdapter, type AsyncDatabaseSession } from '../db/asyncAdapter';
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

export class AsyncPrivacyAnalyticsRepository implements PrivacyAnalyticsStore {
  constructor(private readonly database: AsyncDatabaseAdapter) {}

  recordConsent(input: RecordConsentInput) {
    const subjectHash = hashPrivacySubject(input.subjectId);
    const receiptId = randomUUID();
    const policyVersion = input.policyVersion ?? PRIVACY_POLICY_VERSION;
    return this.database.transaction(async (session) => {
      await this.lockSubject(session, subjectHash);
      const rows = await session.query<ConsentRow>({
        text: `
          INSERT INTO privacy_consent_receipts (
            receipt_id, subject_hash, policy_version, analytics_granted, action, source
          ) VALUES (
            $1, $2, $3, $4,
            CASE
              WHEN $4 THEN 'granted'
              WHEN COALESCE((
                SELECT analytics_granted FROM privacy_consent_receipts
                WHERE subject_hash = $2 ORDER BY id DESC LIMIT 1
              ), ${this.database.dialect === 'postgres' ? 'FALSE' : '0'}) THEN 'withdrawn'
              ELSE 'denied'
            END,
            $5
          )
          RETURNING id, receipt_id, policy_version, analytics_granted, action, created_at;
        `,
        values: [receiptId, subjectHash, policyVersion, input.analytics, input.source],
      });
      if (!rows[0]) throw new Error('privacy consent receipt could not be loaded');
      return mapConsentReceipt(rows[0]);
    });
  }

  recordEvent(input: RecordAnalyticsEventInput) {
    const subjectHash = hashPrivacySubject(input.subjectId);
    return this.database.transaction(async (session) => {
      await this.lockSubject(session, subjectHash);
      if (!await this.hasCurrentGrant(session, subjectHash, input.consentReceiptId)) return null;

      const existing = await this.findEvent(session, input.eventId);
      if (existing) return this.replay(existing, input, subjectHash);

      const granted = this.database.dialect === 'postgres' ? 'TRUE' : '1';
      const rows = await session.query<AnalyticsRow>({
        text: `
          INSERT INTO product_analytics_events (
            event_id, consent_receipt_id, subject_hash, event_name,
            path, properties_json, occurred_at
          )
          SELECT $1, consent.id, $2, $3, $4, $5, $6
          FROM privacy_consent_receipts consent
          WHERE consent.receipt_id = $7
            AND consent.subject_hash = $2
            AND consent.analytics_granted = ${granted}
            AND consent.id = (
              SELECT MAX(latest.id) FROM privacy_consent_receipts latest
              WHERE latest.subject_hash = $2
            )
          ON CONFLICT(event_id) DO NOTHING
          RETURNING id, event_id, $7 AS consent_receipt_ref,
            subject_hash, event_name, path, properties_json, occurred_at;
        `,
        values: [
          input.eventId,
          subjectHash,
          input.eventName,
          input.path,
          JSON.stringify(input.properties),
          input.occurredAt,
          input.consentReceiptId,
        ],
      });
      if (rows[0]) return { ...mapAnalyticsEvent(rows[0]), duplicate: false };

      const raced = await this.findEvent(session, input.eventId);
      return raced ? this.replay(raced, input, subjectHash) : null;
    });
  }

  private async lockSubject(session: AsyncDatabaseSession, subjectHash: string): Promise<void> {
    if (this.database.dialect !== 'postgres') return;
    await session.query({
      text: 'SELECT pg_advisory_xact_lock(hashtext($1));',
      values: [subjectHash],
    });
  }

  private async hasCurrentGrant(
    session: AsyncDatabaseSession,
    subjectHash: string,
    receiptId: string,
  ): Promise<boolean> {
    const granted = this.database.dialect === 'postgres' ? 'TRUE' : '1';
    const rows = await session.query<{ id: number }>({
      text: `
        SELECT id FROM privacy_consent_receipts
        WHERE receipt_id = $1 AND subject_hash = $2 AND analytics_granted = ${granted}
          AND id = (
            SELECT MAX(latest.id) FROM privacy_consent_receipts latest
            WHERE latest.subject_hash = $2
          )
        LIMIT 1;
      `,
      values: [receiptId, subjectHash],
    });
    return Boolean(rows[0]);
  }

  private async findEvent(
    session: AsyncDatabaseSession,
    eventId: string,
  ): Promise<AnalyticsRow | null> {
    const rows = await session.query<AnalyticsRow>({
      text: `
        SELECT events.id, events.event_id, consent.receipt_id AS consent_receipt_ref,
          events.subject_hash, events.event_name, events.path, events.properties_json,
          events.occurred_at
        FROM product_analytics_events events
        JOIN privacy_consent_receipts consent ON consent.id = events.consent_receipt_id
        WHERE events.event_id = $1 LIMIT 1;
      `,
      values: [eventId],
    });
    return rows[0] ?? null;
  }

  private replay(
    row: AnalyticsRow,
    input: RecordAnalyticsEventInput,
    subjectHash: string,
  ) {
    if (!sameAnalyticsEvent(row, input, subjectHash)) {
      throw new Error('analytics event idempotency conflict');
    }
    return { ...mapAnalyticsEvent(row), duplicate: true };
  }
}
