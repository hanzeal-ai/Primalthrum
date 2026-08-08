import { type Awaitable } from './storeTypes';

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

export interface RecordConsentInput {
  subjectId: string;
  analytics: boolean;
  source: ConsentSource;
  policyVersion?: string;
}

export interface RecordAnalyticsEventInput {
  subjectId: string;
  consentReceiptId: string;
  eventId: string;
  eventName: AnalyticsEventName;
  path: string;
  properties: Record<string, string | boolean>;
  occurredAt: string;
}

export interface PrivacyAnalyticsStore {
  recordConsent(input: RecordConsentInput): Awaitable<ConsentReceipt>;
  recordEvent(input: RecordAnalyticsEventInput): Awaitable<ProductAnalyticsEvent | null>;
}
