export type RunStatus = 'idle' | 'running' | 'done' | 'error'

export interface AgentConfig {
  memoryProvider: string
  cacheProvider: string
  ragProvider: string
  enabledTools: string[]
  enabledSkills: string[]
  modelConfig: Record<string, unknown>
  audience: 'workspace' | 'public'
}

export interface HostedAgentRecord {
  id: number
  name: string
  slug: string
  description: string
  status: string
}

export interface AgentRecord {
  id: number
  workspaceId: number
  name: string
  slug: string
  description: string
  path: string
  status: string
  config: AgentConfig
}

export interface GeneratedProject {
  path: string
  files: string[]
}

export interface DocumentRecord {
  id: number
  agentId: number
  workspaceId: number
  filename: string
  hash: string
  indexStatus: string
  collection: string
}

export interface CreateDocumentInput {
  filename: string
  content: string
  collection?: string
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
  audience?: 'workspace' | 'public'
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

export interface ProviderConfigRecord {
  id: number
  workspaceId: number
  name: string
  type: string
  config: Record<string, unknown>
  secretRef: string
}

export interface SaveProviderConfigInput {
  name?: string
  type?: string
  config?: Record<string, unknown>
  secret?: string
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

export interface SourceReference {
  title: string
  documentId?: number
  chunkId?: string
  url?: string
}

export interface ConversationRecord {
  id: number
  workspaceId: number
  agentId: number
  title: string
  createdAt: string
  updatedAt: string
}

export interface ConversationMessageRecord {
  id: number
  workspaceId: number
  conversationId: number
  role: 'user' | 'assistant' | 'system'
  content: string
  sources: SourceReference[]
  createdAt: string
}

export interface StreamPayload {
  node?: string
  agent?: string
  message?: string
  delta?: string
  status?: RunStatus | string
  tools?: string[]
  plan?: string[]
  artifacts?: string[]
  checks?: string[]
  sources?: SourceReference[]
}

export interface ParsedSseEvent {
  event: string
  data: StreamPayload
}

export type StreamAgentRequest = LegacyStreamAgentRequest | StoredAgentStreamRequest

export interface LegacyStreamAgentRequest {
  agent: string
  goal: string
  tools: string[]
}

export interface StoredAgentStreamRequest {
  agentId: number
  input: string
  conversationId?: number
}

export interface StreamResult {
  runId?: number
  conversationId?: number
}

export interface AuthUser {
  id: number
  workspaceId: number
  email: string
  role: string
}

export interface AuthSession {
  token: string
  expiresAt: string
}

export interface AuthResponse {
  user: AuthUser
  session: AuthSession
}

export interface CurrentSession {
  user: AuthUser
  expiresAt: string
}

export interface SetupStatus {
  needsSetup: boolean
}

export interface AuthCredentials {
  email: string
  password: string
}
