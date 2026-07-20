export type RunStatus = 'idle' | 'running' | 'done' | 'error'

export interface AgentConfig {
  memoryProvider: string
  cacheProvider: string
  ragProvider: string
  enabledTools: string[]
  enabledSkills: string[]
  modelConfig: Record<string, unknown>
}

export interface AgentRecord {
  id: number
  name: string
  slug: string
  description: string
  path: string
  status: string
  config: AgentConfig
}

export interface CreateAgentInput {
  name: string
  description?: string
  memoryProvider?: string
  cacheProvider?: string
  ragProvider?: string
  enabledTools?: string[]
  enabledSkills?: string[]
  modelConfig?: Record<string, unknown>
}

export interface ProviderInfo {
  name: string
  status: string
  description: string
}

export interface ProviderCatalog {
  llm: ProviderInfo[]
  memory: ProviderInfo[]
  cache: ProviderInfo[]
  rag: ProviderInfo[]
}

export interface ToolInfo {
  name: string
  description: string
  status: string
  permissions: string[]
  dangerous: boolean
}

export interface SkillInfo {
  name: string
  version: string
  description: string
  status: string
  tools: string[]
  rag: boolean
}

export interface StreamPayload {
  node?: string
  agent?: string
  message?: string
  status?: RunStatus | string
  tools?: string[]
  plan?: string[]
  artifacts?: string[]
  checks?: string[]
}

export interface ParsedSseEvent {
  event: string
  data: StreamPayload
}

export interface StreamAgentRequest {
  agent: string
  goal: string
  tools: string[]
}
