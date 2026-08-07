import { type AgentRecord, type CreateAgentInput } from './agentRepository';
import { type Awaitable } from './storeTypes';

export interface AgentStore {
  create(input: CreateAgentInput, workspaceId: number): Awaitable<AgentRecord>;
  list(workspaceId: number): Awaitable<AgentRecord[]>;
  findById(id: number): Awaitable<AgentRecord | null>;
  findByIdInWorkspace(id: number, workspaceId: number): Awaitable<AgentRecord | null>;
  markGenerated(id: number): Awaitable<AgentRecord>;
  updateAudience(id: number, audience: unknown, workspaceId: number): Awaitable<AgentRecord>;
  findBySlug(slug: string): Awaitable<AgentRecord | null>;
}
