import { type OperatorCustomerUserSummary } from './operatorCustomerReadRepository';
import { type Awaitable } from './storeTypes';

export interface OperatorCustomerReadStore {
  listUsers(
    workspaceId: number | undefined,
    limit?: number,
  ): Awaitable<OperatorCustomerUserSummary[]>;
}
