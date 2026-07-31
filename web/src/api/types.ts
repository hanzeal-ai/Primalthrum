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

export interface AgentVersionRecord {
  id: number
  workspaceId: number
  agentId: number
  versionNumber: number
  status: 'preview' | 'published'
  config: AgentConfig
  sourcePath: string
  checksum: string
  createdByUserId: number | null
  createdAt: string
  publishedAt: string | null
}

export interface AgentDeploymentRecord {
  id: number
  workspaceId: number
  agentId: number
  versionId: number
  environment: 'preview' | 'production'
  status: 'active' | 'inactive'
  trigger: 'preview' | 'publish' | 'rollback' | 'migration'
  urlPath: string
  createdByUserId: number | null
  createdAt: string
  activatedAt: string
  deactivatedAt: string | null
}

export interface AgentVersionLifecycleResult {
  version: AgentVersionRecord
  deployment: AgentDeploymentRecord
}

export interface DocumentRecord {
  id: number
  agentId: number
  workspaceId: number
  filename: string
  hash: string
  indexStatus: string
  collection: string
  storageRef: string
  mimeType: string
  sizeBytes: number
}

export interface CreateDocumentInput {
  filename: string
  content: string
  collection?: string
}

export interface UploadDocumentInput {
  filename: string
  mimeType: string
  content: string
  collection?: string
}

export interface JobRecord {
  id: number
  workspaceId: number
  type: string
  status: 'queued' | 'running' | 'retrying' | 'succeeded' | 'failed'
  attempts: number
  maxAttempts: number
  payload: Record<string, unknown>
  result: Record<string, unknown>
  error: string
}

export interface TranscriptionResult {
  provider: string
  model: string
  text: string
}

export interface SpeechSynthesisResult {
  provider: string
  model: string
  mimeType: string
  audioBase64: string
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
  embedding: ProviderInfo[]
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

export interface RuntimeCapabilityRecord {
  kind: string
  name: string
  version: string
  description: string
  status: 'available' | 'planned'
  hotPluggable: boolean
  configSchema: Record<string, unknown>
  permissions: string[]
  dependencies: string[]
  enabled: boolean
}

export interface RuntimeCapabilityCatalog {
  schemaVersion: string
  capabilities: RuntimeCapabilityRecord[]
  health: Array<{ key: string; status: string }>
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
  id?: number
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
  versionId?: number
}

export interface StreamResult {
  runId?: number
  conversationId?: number
  idempotencyKey?: string
  lastEventId?: number
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

export interface WorkspaceRecord {
  id: number
  name: string
  slug: string
  role: 'owner' | 'admin' | 'member' | 'viewer'
  createdAt: string
  updatedAt: string
}

export interface CreateWorkspaceResponse {
  workspace: Omit<WorkspaceRecord, 'role'>
  session: CurrentSession
}

export interface SetupStatus {
  needsSetup: boolean
}

export interface AuthCredentials {
  email: string
  password: string
}
