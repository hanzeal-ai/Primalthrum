import type { AgentRepository } from './agentRepository';
import type { RunRepository } from './runRepository';

export interface AgentStreamPayload {
  goal: string;
  agent: string;
  tools: string[];
  skills: string[];
  memory_provider: string;
  cache_provider: string;
  rag_provider: string;
  context?: string;
  sources?: Array<{
    title: string;
    documentId?: number;
    chunkId?: string;
  }>;
}

export interface ResolvedStreamRequest {
  payload: AgentStreamPayload;
  runId: number | null;
}

export function resolveStreamRequest(
  body: unknown,
  agentRepository: AgentRepository,
  runRepository: RunRepository,
  workspaceId?: number,
): ResolvedStreamRequest {
  const candidate = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const agentId = Number(candidate.agentId);

  if (Number.isInteger(agentId) && agentId > 0) {
    const agent = typeof workspaceId === 'number'
      ? agentRepository.findByIdInWorkspace(agentId, workspaceId)
      : agentRepository.findById(agentId);
    if (!agent) {
      throw new StreamRequestError(404, 'agent not found');
    }

    const input = toText(candidate.input ?? candidate.goal ?? candidate.task_desc, '');
    if (!input) {
      throw new StreamRequestError(400, 'run input is required');
    }

    const run = runRepository.create({
      agentId: agent.id,
      input,
    });

    return {
      runId: run.id,
      payload: {
        goal: input,
        agent: agent.name,
        tools: agent.config.enabledTools,
        skills: agent.config.enabledSkills,
        memory_provider: agent.config.memoryProvider,
        cache_provider: agent.config.cacheProvider,
        rag_provider: agent.config.ragProvider,
      },
    };
  }

  return {
    runId: null,
    payload: normalizeLegacyPayload(candidate),
  };
}

export class StreamRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function normalizeLegacyPayload(candidate: Record<string, unknown>): AgentStreamPayload {
  const goal = toText(candidate.goal ?? candidate.task_desc, '');
  if (!goal) {
    throw new StreamRequestError(400, 'goal is required');
  }

  return {
    goal,
    agent: toText(candidate.agent ?? candidate.agent_name, 'ResearchAgent'),
    tools: toList(candidate.tools),
    skills: toList(candidate.skills),
    memory_provider: toText(candidate.memory_provider, 'null'),
    cache_provider: toText(candidate.cache_provider, 'memory'),
    rag_provider: toText(candidate.rag_provider, 'null'),
  };
}

function toText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function toList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  if (typeof value === 'string') {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }

  return [];
}
