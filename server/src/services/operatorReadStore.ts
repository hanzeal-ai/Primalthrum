import { type SupportGrantPermission } from './operatorAuthorization';
import {
  type OperatorOverview,
  type OperatorWorkspaceSummary,
} from './operatorReadRepository';
import { type Awaitable } from './storeTypes';

export interface OperatorReadStore {
  overview(): Awaitable<OperatorOverview>;
  listWorkspaces(limit?: number): Awaitable<OperatorWorkspaceSummary[]>;
  workspace(id: number): Awaitable<OperatorWorkspaceSummary | null>;
  supportContext(
    workspaceId: number,
    permissions: SupportGrantPermission[],
  ): Awaitable<Record<string, unknown> | null>;
}
