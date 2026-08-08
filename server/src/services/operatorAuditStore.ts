import { type OperatorAuditRecord } from './operatorAuditRepository';
import { type Awaitable } from './storeTypes';

export interface RecordOperatorAuditInput {
  operatorUserId?: number | null;
  eventType: string;
  targetType?: string;
  targetId?: string | number;
  metadata?: Record<string, unknown>;
}

export interface OperatorAuditStore {
  record(input: RecordOperatorAuditInput): Awaitable<OperatorAuditRecord>;
  list(limit?: number): Awaitable<OperatorAuditRecord[]>;
}
