import type { AgentStore } from './agentStore';
import type { AgentVersionStore } from './agentVersionStore';
import {
  CapabilityDisabledError,
} from './capabilitySettingsRepository';
import { type CapabilitySettingsStore } from './capabilitySettingsStore';
import type { RunStore } from './runStore';
import type {
  RuntimeModelEndpoint,
  RuntimeProviderResolver,
} from './runtimeProviderResolver';

export interface AgentStreamPayload {
  goal: string;
  agent: string;
  tools: string[];
  skills: string[];
  memory_provider: string;
  memory_path?: string;
  cache_provider: string;
  cache_path?: string;
  rag_provider: string;
  llm: RuntimeModelEndpoint;
  embedding: RuntimeModelEndpoint;
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

export interface StreamRunIdentity {
  idempotencyKey: string;
  requestHash: string;
}

export async function resolveStreamRequest(
  body: unknown,
  agentRepository: AgentStore,
  runRepository: RunStore,
  workspaceId?: number,
  agentVersionRepository?: AgentVersionStore,
  runtimeProviderResolver?: RuntimeProviderResolver,
  capabilitySettings?: CapabilitySettingsStore,
  runIdentity?: StreamRunIdentity,
): Promise<ResolvedStreamRequest> {
  const candidate = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const agentId = Number(candidate.agentId);

  if (Number.isInteger(agentId) && agentId > 0) {
    const agent = typeof workspaceId === 'number'
      ? await agentRepository.findByIdInWorkspace(agentId, workspaceId)
      : await agentRepository.findById(agentId);
    if (!agent) {
      throw new StreamRequestError(404, 'agent not found');
    }

    const requestedVersionId = optionalPositiveInteger(candidate.versionId, 'versionId');
    const version = typeof workspaceId === 'number' && agentVersionRepository
      ? await agentVersionRepository.resolveForRun(
          agent.id,
          workspaceId,
          requestedVersionId ?? undefined,
        )
      : null;
    if (requestedVersionId && !version) {
      throw new StreamRequestError(404, 'agent version not found');
    }
    const config = version?.config ?? agent.config;
    const providers = typeof workspaceId === 'number' && runtimeProviderResolver
      ? await runtimeProviderResolver.resolve(config, workspaceId)
      : mockRuntimeProviders();
    const capabilitySnapshot = typeof workspaceId === 'number' && capabilitySettings
      ? await capabilitySettings.snapshot(workspaceId, capabilityKeysForConfig(config, providers))
      : undefined;
    if (capabilitySnapshot && capabilitySettings) {
      try {
        capabilitySettings.assertEnabled(capabilitySnapshot);
      } catch (error) {
        if (error instanceof CapabilityDisabledError) {
          throw new StreamRequestError(409, error.message);
        }
        throw error;
      }
    }

    const input = toText(candidate.input ?? candidate.goal ?? candidate.task_desc, '');
    if (!input) {
      throw new StreamRequestError(400, 'run input is required');
    }

    const run = await runRepository.create({
      agentId: agent.id,
      agentVersionId: version?.id,
      idempotencyKey: runIdentity?.idempotencyKey,
      requestHash: runIdentity?.requestHash,
      capabilitySnapshot,
      input,
    });

    return {
      runId: run.id,
      payload: {
        goal: input,
        agent: agent.name,
        tools: config.enabledTools,
        skills: config.enabledSkills,
        memory_provider: config.memoryProvider,
        cache_provider: config.cacheProvider,
        ...runtimePersistencePaths(
          workspaceId,
          agent.id,
          config.memoryProvider,
          config.cacheProvider,
        ),
        rag_provider: config.ragProvider,
        llm: providers.llm,
        embedding: providers.embedding,
      },
    };
  }

  return {
    runId: null,
    payload: normalizeLegacyPayload(candidate),
  };
}

export function capabilityKeysForConfig(
  config: {
    memoryProvider: string;
    cacheProvider: string;
    ragProvider: string;
    enabledTools: string[];
    enabledSkills: string[];
  },
  providers: ReturnType<typeof mockRuntimeProviders>,
): string[] {
  return [
    `llm:${providers.llm.provider}`,
    `embedding:${providers.embedding.provider}`,
    `memory:${config.memoryProvider}`,
    `cache:${config.cacheProvider}`,
    `rag:${config.ragProvider}`,
    ...config.enabledTools.map((name) => `tool:${name}`),
    ...config.enabledSkills.map((name) => `skill:${name}`),
  ];
}

function optionalPositiveInteger(value: unknown, name: string): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new StreamRequestError(400, `${name} must be a positive integer`);
  }
  return parsed;
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
    llm: mockRuntimeProviders().llm,
    embedding: mockRuntimeProviders().embedding,
  };
}

function mockRuntimeProviders() {
  return {
    llm: { provider: 'mock', model: 'mock-chat' },
    embedding: { provider: 'mock', model: 'mock-embedding' },
  };
}

function runtimePersistencePaths(
  workspaceId: number | undefined,
  agentId: number,
  memoryProvider: string,
  cacheProvider: string,
): Partial<Pick<AgentStreamPayload, 'memory_path' | 'cache_path'>> {
  if (typeof workspaceId !== 'number') return {};
  const root = `.primalthrum/workspaces/${workspaceId}/agents/${agentId}`;
  return {
    ...(memoryProvider === 'sqlite' ? { memory_path: `${root}/memory.sqlite3` } : {}),
    ...(cacheProvider === 'sqlite' ? { cache_path: `${root}/cache.sqlite3` } : {}),
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
