import { type Awaitable } from './storeTypes';
import {
  type CreditAccountRecord,
  type CreditReservationRecord,
  type UsageEventRecord,
} from './billingTypes';

export interface GrantCreditsInput {
  workspaceId: number;
  amount: number;
  idempotencyKey: string;
  sourceType: string;
  sourceRef: string;
}

export interface ReserveCreditsInput {
  workspaceId: number;
  idempotencyKey: string;
  meter: string;
  credits: number;
}

export interface SettleCreditsInput {
  workspaceId: number;
  reservationKey: string;
  usageIdempotencyKey: string;
  quantity: number;
  actualCredits: number;
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
}

export interface RefundCreditsInput {
  workspaceId: number;
  usageEventId: number;
  credits: number;
  idempotencyKey: string;
  sourceRef: string;
}

export interface CreditLedgerStore {
  grant(input: GrantCreditsInput): Awaitable<CreditAccountRecord>;
  reserve(input: ReserveCreditsInput): Awaitable<CreditReservationRecord>;
  settle(input: SettleCreditsInput): Awaitable<UsageEventRecord>;
  release(
    workspaceId: number,
    reservationKey: string,
  ): Awaitable<CreditReservationRecord>;
  refund(input: RefundCreditsInput): Awaitable<CreditAccountRecord>;
  account(workspaceId: number): Awaitable<CreditAccountRecord>;
}
