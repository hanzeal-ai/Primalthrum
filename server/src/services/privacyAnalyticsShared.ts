import { createHash } from 'node:crypto';

import { databaseTimestamp } from '../db/databaseTimestamp';
import {
  type ConsentReceipt,
  type ProductAnalyticsEvent,
  type RecordAnalyticsEventInput,
} from './privacyAnalyticsStore';

export interface ConsentRow {
  id: number;
  receipt_id: string;
  policy_version: string;
  analytics_granted: boolean | number;
  action: ConsentReceipt['action'];
  created_at: string | Date;
}

export interface AnalyticsRow {
  id: number;
  event_id: string;
  consent_receipt_ref: string;
  subject_hash: string;
  event_name: ProductAnalyticsEvent['eventName'];
  path: string;
  properties_json: string;
  occurred_at: string | Date;
}

export function hashPrivacySubject(subjectId: string): string {
  return createHash('sha256').update(`primalthrum-consent:${subjectId}`).digest('hex');
}

export function mapConsentReceipt(row: ConsentRow): ConsentReceipt {
  return {
    receiptId: row.receipt_id,
    policyVersion: row.policy_version,
    necessary: true,
    analytics: Boolean(row.analytics_granted),
    action: row.action,
    recordedAt: databaseTimestamp(row.created_at),
  };
}

export function mapAnalyticsEvent(
  row: AnalyticsRow,
): Omit<ProductAnalyticsEvent, 'duplicate'> {
  return {
    id: Number(row.id),
    eventId: row.event_id,
    eventName: row.event_name,
    path: row.path,
    properties: JSON.parse(row.properties_json) as Record<string, string | boolean>,
    occurredAt: databaseTimestamp(row.occurred_at),
  };
}

export function sameAnalyticsEvent(
  row: AnalyticsRow,
  input: RecordAnalyticsEventInput,
  subjectHash: string,
): boolean {
  return row.consent_receipt_ref === input.consentReceiptId
    && row.subject_hash === subjectHash
    && row.event_name === input.eventName
    && row.path === input.path
    && row.properties_json === JSON.stringify(input.properties)
    && databaseTimestamp(row.occurred_at) === databaseTimestamp(input.occurredAt);
}
