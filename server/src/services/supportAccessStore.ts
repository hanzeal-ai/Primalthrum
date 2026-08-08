import { type SupportAccessGrantRecord } from './supportAccessRepository';
import { type Awaitable } from './storeTypes';

export interface CreateSupportAccessGrantInput {
  workspaceId: number;
  operatorUserId: number;
  permissions: unknown;
  reason: unknown;
  ticketRef: unknown;
  expiresAt: unknown;
  createdByOperatorId: number;
}

export interface SupportAccessStore {
  create(input: CreateSupportAccessGrantInput): Awaitable<SupportAccessGrantRecord>;
  list(operatorUserId?: number): Awaitable<SupportAccessGrantRecord[]>;
  findActive(id: number, operatorUserId: number): Awaitable<SupportAccessGrantRecord | null>;
  revoke(id: number, revokedByOperatorId: number): Awaitable<SupportAccessGrantRecord | null>;
}
