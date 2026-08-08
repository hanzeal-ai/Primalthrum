import { type Awaitable } from './storeTypes';
import { type EntitlementRecord, type EntitlementSnapshot } from './billingTypes';

export interface GrantEntitlementInput {
  workspaceId: number;
  feature: string;
  enabled: boolean;
  quantityLimit?: number | null;
  sourceType: string;
  sourceRef: string;
  priority?: number;
  startsAt?: string;
  endsAt?: string | null;
}

export interface EntitlementStore {
  snapshot(workspaceId: number): Awaitable<EntitlementSnapshot>;
  assert(
    workspaceId: number,
    feature: string,
    currentUsage?: number,
    requestedQuantity?: number,
  ): Awaitable<EntitlementRecord>;
  grant(input: GrantEntitlementInput): Awaitable<EntitlementSnapshot>;
}
