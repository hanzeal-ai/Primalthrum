import type {
  AgentRecord,
  CreateAgentInput,
  GeneratedProject,
  ParsedSseEvent,
  ProviderCatalog,
  SkillInfo,
  StreamAgentRequest,
  StreamPayload,
  ToolInfo,
} from './types'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? ''

export async function listAgents(): Promise<AgentRecord[]> {
  return apiFetch<AgentRecord[]>('/api/agents')
}

export async function createAgent(input: CreateAgentInput): Promise<AgentRecord> {
  return apiFetch<AgentRecord>('/api/agents', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export async function generateAgentProject(agentId: number): Promise<GeneratedProject> {
  return apiFetch<GeneratedProject>(`/api/agents/${agentId}/generate`, {
    method: 'POST',
  })
}

export async function listProviders(): Promise<ProviderCatalog> {
  return apiFetch<ProviderCatalog>('/api/providers')
}

export async function listTools(): Promise<ToolInfo[]> {
  return apiFetch<ToolInfo[]>('/api/tools')
}

export async function listSkills(): Promise<SkillInfo[]> {
  return apiFetch<SkillInfo[]>('/api/skills')
}

export async function streamAgentRun(
  input: StreamAgentRequest,
  options: {
    signal?: AbortSignal
    onEvent: (event: ParsedSseEvent) => void
  },
): Promise<void> {
  const response = await fetch(apiUrl('/api/stream'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal: options.signal,
  })

  if (!response.ok || !response.body) {
    throw new Error(`Stream request failed with HTTP ${response.status}`)
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += value
    const blocks = buffer.split('\n\n')
    buffer = blocks.pop() ?? ''

    for (const block of blocks) {
      const parsed = parseSseBlock(block)
      if (parsed) {
        options.onEvent(parsed)
      }
    }
  }
}

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(apiUrl(path), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init.headers,
    },
  })

  if (!response.ok) {
    throw new Error(`API request failed with HTTP ${response.status}`)
  }

  return response.json() as Promise<T>
}

function parseSseBlock(block: string): ParsedSseEvent | null {
  const lines = block.split('\n')
  const event = lines
    .find((line) => line.startsWith('event:'))
    ?.replace('event:', '')
    .trim() ?? 'message'
  const data = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.replace('data:', '').trim())
    .join('')

  if (!data) {
    return null
  }

  try {
    return { event, data: JSON.parse(data) as StreamPayload }
  } catch {
    return null
  }
}

function apiUrl(path: string): string {
  return `${API_BASE_URL}${path}`
}
