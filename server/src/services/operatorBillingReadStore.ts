import {
  type OperatorPaymentSummary,
  type OperatorSubscriptionSummary,
  type OperatorUsageSummary,
} from './operatorBillingReadRepository';
import { type Awaitable } from './storeTypes';

export interface OperatorBillingReadStore {
  listSubscriptions(
    workspaceId: number | undefined,
    limit?: number,
  ): Awaitable<OperatorSubscriptionSummary[]>;
  listUsage(
    workspaceId: number | undefined,
    limit?: number,
  ): Awaitable<OperatorUsageSummary[]>;
  listPayments(
    workspaceId: number | undefined,
    limit?: number,
  ): Awaitable<OperatorPaymentSummary>;
}
