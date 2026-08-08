import {
  type AccountEmailDeliveryReceipt,
  type AccountEmailMessage,
} from './accountEmailSender';
import { type Awaitable } from './storeTypes';

export interface ClaimedAccountEmail extends AccountEmailMessage {
  attempts: number;
}

export type AccountEmailProviderEventType =
  | 'accepted'
  | 'delivered'
  | 'delayed'
  | 'bounced'
  | 'complained'
  | 'rejected';

export interface AccountEmailProviderEvent {
  provider: string;
  providerEventId: string;
  providerMessageId: string;
  eventType: AccountEmailProviderEventType;
  occurredAt: string;
}

export interface AccountEmailProviderEventResult {
  duplicate: boolean;
  matched: boolean;
  outboxId: number | null;
}

export interface AccountEmailDeliverySummary {
  pending: number;
  delivering: number;
  delivered: number;
  retrying: number;
  deadLettered: number;
  bounced: number;
  complained: number;
}

export interface AccountEmailOutboxStore {
  enqueue(input: Omit<AccountEmailMessage, 'id'>): Awaitable<void>;
  supersedePending(
    userId: number,
    template: AccountEmailMessage['template'],
  ): Awaitable<void>;
  supersedePendingInvitations(
    workspaceId: number,
    recipientEmail: string,
    exceptInvitationId?: number,
  ): Awaitable<void>;
  supersedeInvitation(invitationId: number): Awaitable<void>;
  claimNext(): Awaitable<ClaimedAccountEmail | null>;
  markDelivered(id: number, receipt: AccountEmailDeliveryReceipt): Awaitable<void>;
  markFailed(
    id: number,
    attempts: number,
    error: string,
    options?: { retryable?: boolean; retryAfterMs?: number; maxAttempts?: number },
  ): Awaitable<{ deadLettered: boolean }>;
  nextAttemptDelayMs(): Awaitable<number | null>;
  recordProviderEvent(
    input: AccountEmailProviderEvent,
  ): Awaitable<AccountEmailProviderEventResult>;
  summary(): Awaitable<AccountEmailDeliverySummary>;
}
