import {
  type OperatorIncidentDetail,
  type OperatorIncidentEvent,
  type OperatorIncidentSummary,
} from './operatorIncidentRepository';
import { type Awaitable } from './storeTypes';

export interface OperatorIncidentStore {
  list(limit?: number): Awaitable<OperatorIncidentSummary[]>;
  find(id: number): Awaitable<OperatorIncidentDetail | null>;
  create(input: {
    title: unknown;
    severity: unknown;
    impactScope: unknown;
    workspaceId: unknown;
    summary: unknown;
    startedAt: unknown;
    ownerOperatorId: unknown;
    operatorUserId: number;
  }): Awaitable<OperatorIncidentDetail>;
  update(id: number, input: {
    title: unknown;
    severity: unknown;
    status: unknown;
    impactScope: unknown;
    workspaceId: unknown;
    summary: unknown;
    ownerOperatorId: unknown;
    expectedRevision: unknown;
    operatorUserId: number;
  }): Awaitable<OperatorIncidentDetail>;
  appendEvent(id: number, input: {
    eventType: unknown;
    message: unknown;
    operatorUserId: number;
  }): Awaitable<OperatorIncidentEvent>;
}
