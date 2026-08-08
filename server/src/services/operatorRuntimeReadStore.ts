import {
  type OperatorAgentSummary,
  type OperatorJobSummary,
} from './operatorRuntimeReadRepository';
import { type Awaitable } from './storeTypes';

export interface OperatorRuntimeReadStore {
  listAgents(
    workspaceId: number | undefined,
    limit?: number,
  ): Awaitable<OperatorAgentSummary[]>;
  listJobs(
    workspaceId: number | undefined,
    limit?: number,
  ): Awaitable<OperatorJobSummary[]>;
}
