import {
  type OperatorFeatureFlag,
  type OperatorFeatureFlagEvent,
  type OperatorFeatureFlagOverride,
} from './operatorFeatureFlagRepository';
import { type Awaitable } from './storeTypes';

export interface OperatorFeatureFlagStore {
  list(): Awaitable<OperatorFeatureFlag[]>;
  find(id: number): Awaitable<OperatorFeatureFlag | null>;
  create(input: {
    key: unknown;
    description: unknown;
    enabled: unknown;
    killSwitch: unknown;
    rolloutPercentage: unknown;
    operatorUserId: number;
  }): Awaitable<OperatorFeatureFlag>;
  update(id: number, input: {
    description: unknown;
    enabled: unknown;
    killSwitch: unknown;
    rolloutPercentage: unknown;
    expectedRevision: unknown;
    operatorUserId: number;
  }): Awaitable<OperatorFeatureFlag>;
  createOverride(flagId: number, input: {
    workspaceId: unknown;
    enabled: unknown;
    reason: unknown;
    operatorUserId: number;
  }): Awaitable<OperatorFeatureFlagOverride>;
  revokeOverride(flagId: number, overrideId: number, input: {
    expectedRevision: unknown;
    operatorUserId: number;
  }): Awaitable<OperatorFeatureFlagOverride>;
  listEvents(flagId: number, limit?: number): Awaitable<OperatorFeatureFlagEvent[]>;
  evaluate(key: string, input?: {
    workspaceId?: number;
    subjectKey?: string;
  }): Awaitable<boolean>;
}
