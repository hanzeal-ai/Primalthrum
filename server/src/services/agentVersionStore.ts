import { type AgentRecord } from './agentRepository';
import {
  type AgentDeploymentRecord,
  type AgentVersionRecord,
} from './agentVersionRepository';
import { type Awaitable } from './storeTypes';

export interface AgentVersionMutation {
  version: AgentVersionRecord;
  deployment: AgentDeploymentRecord;
}

export interface AgentVersionStore {
  createPreview(agent: AgentRecord, createdByUserId: number): Awaitable<AgentVersionMutation>;
  publish(
    agent: AgentRecord,
    versionId: number,
    createdByUserId: number,
    trigger?: 'publish' | 'rollback',
  ): Awaitable<AgentVersionMutation>;
  listVersions(agentId: number, workspaceId: number): Awaitable<AgentVersionRecord[]>;
  listDeployments(agentId: number, workspaceId: number): Awaitable<AgentDeploymentRecord[]>;
  findById(id: number, workspaceId: number): Awaitable<AgentVersionRecord | null>;
  resolveForRun(
    agentId: number,
    workspaceId: number,
    requestedVersionId?: number,
  ): Awaitable<AgentVersionRecord | null>;
}
