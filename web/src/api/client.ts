import type {
  AgentRecord,
  AgentDeploymentRecord,
  AgentVersionLifecycleResult,
  AgentVersionRecord,
  AuthCredentials,
  AuthResponse,
  ConversationMessageRecord,
  ConversationRecord,
  CreateAgentInput,
  CreateDocumentInput,
  CreateWorkspaceResponse,
  CurrentSession,
  DocumentRecord,
  GeneratedProject,
  HostedAgentRecord,
  ParsedSseEvent,
  ProviderCatalog,
  ProviderConfigRecord,
  SaveProviderConfigInput,
  SetupStatus,
  SkillInfo,
  StreamAgentRequest,
  StreamPayload,
  StreamResult,
  ToolInfo,
  WorkspaceRecord,
} from './types'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? ''
const SESSION_TOKEN_KEY = 'primalthrum.sessionToken'

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: unknown

  constructor(
    message: string,
    status: number,
    code = 'API_ERROR',
    details?: unknown,
  ) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message = 'Authentication required', code = 'AUTHENTICATION_REQUIRED') {
    super(message, 401, code)
  }
}

export function isUnauthorizedError(error: unknown): error is UnauthorizedError {
  return error instanceof UnauthorizedError
}

export function getStoredSessionToken(): string {
  return window.localStorage.getItem(SESSION_TOKEN_KEY) ?? ''
}

export function clearStoredSessionToken(): void {
  window.localStorage.removeItem(SESSION_TOKEN_KEY)
}

export async function getSetupStatus(): Promise<SetupStatus> {
  return apiFetch<SetupStatus>('/api/setup/status', { auth: false })
}

export async function setupAdmin(input: AuthCredentials): Promise<AuthResponse> {
  const response = await apiFetch<AuthResponse>('/api/setup/admin', {
    auth: false,
    method: 'POST',
    body: JSON.stringify(input),
  })
  storeSessionToken(response.session.token)
  return response
}

export async function loginAdmin(input: AuthCredentials): Promise<AuthResponse> {
  const response = await apiFetch<AuthResponse>('/api/auth/login', {
    auth: false,
    method: 'POST',
    body: JSON.stringify(input),
  })
  storeSessionToken(response.session.token)
  return response
}

export async function logoutAdmin(): Promise<void> {
  try {
    await apiFetch<void>('/api/auth/logout', {
      method: 'POST',
      parseJson: false,
    })
  } finally {
    clearStoredSessionToken()
  }
}

export async function getCurrentSession(): Promise<CurrentSession> {
  return apiFetch<CurrentSession>('/api/auth/session')
}

export async function listWorkspaces(): Promise<WorkspaceRecord[]> {
  return apiFetch<WorkspaceRecord[]>('/api/workspaces')
}

export async function createWorkspace(name: string): Promise<CreateWorkspaceResponse> {
  return apiFetch<CreateWorkspaceResponse>('/api/workspaces', {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
}

export async function switchWorkspace(workspaceId: number): Promise<CurrentSession> {
  return apiFetch<CurrentSession>('/api/auth/workspace', {
    method: 'POST',
    body: JSON.stringify({ workspaceId }),
  })
}

export async function listAgents(): Promise<AgentRecord[]> {
  return apiFetch<AgentRecord[]>('/api/agents')
}

export async function getAgentBySlug(slug: string): Promise<AgentRecord> {
  return apiFetch<AgentRecord>(`/api/agents/slug/${encodeURIComponent(slug)}`)
}

export async function getPublicAgentBySlug(slug: string): Promise<HostedAgentRecord> {
  return apiFetch<HostedAgentRecord>(`/api/public/agents/${encodeURIComponent(slug)}`, { auth: false })
}

export async function listConversations(agentId: number): Promise<ConversationRecord[]> {
  return apiFetch<ConversationRecord[]>(`/api/agents/${agentId}/conversations`)
}

export async function createConversation(agentId: number, title = '新对话'): Promise<ConversationRecord> {
  return apiFetch<ConversationRecord>(`/api/agents/${agentId}/conversations`, {
    method: 'POST',
    body: JSON.stringify({ title }),
  })
}

export async function listConversationMessages(conversationId: number): Promise<ConversationMessageRecord[]> {
  return apiFetch<ConversationMessageRecord[]>(`/api/conversations/${conversationId}/messages`)
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

export async function listAgentVersions(agentId: number): Promise<AgentVersionRecord[]> {
  return apiFetch<AgentVersionRecord[]>(`/api/agents/${agentId}/versions`)
}

export async function listAgentDeployments(agentId: number): Promise<AgentDeploymentRecord[]> {
  return apiFetch<AgentDeploymentRecord[]>(`/api/agents/${agentId}/deployments`)
}

export async function createAgentVersion(agentId: number): Promise<AgentVersionLifecycleResult> {
  return apiFetch<AgentVersionLifecycleResult>(`/api/agents/${agentId}/versions`, {
    method: 'POST',
  })
}

export async function publishAgentVersion(
  agentId: number,
  versionId: number,
): Promise<AgentVersionLifecycleResult> {
  return apiFetch<AgentVersionLifecycleResult>(
    `/api/agents/${agentId}/versions/${versionId}/publish`,
    { method: 'POST' },
  )
}

export async function rollbackAgentVersion(
  agentId: number,
  versionId: number,
): Promise<AgentVersionLifecycleResult> {
  return apiFetch<AgentVersionLifecycleResult>(
    `/api/agents/${agentId}/versions/${versionId}/rollback`,
    { method: 'POST' },
  )
}

export async function listDocuments(agentId: number): Promise<DocumentRecord[]> {
  return apiFetch<DocumentRecord[]>(`/api/agents/${agentId}/documents`)
}

export async function createDocument(
  agentId: number,
  input: CreateDocumentInput,
): Promise<DocumentRecord> {
  return apiFetch<DocumentRecord>(`/api/agents/${agentId}/documents`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export async function indexDocument(
  agentId: number,
  documentId: number,
): Promise<DocumentRecord> {
  return apiFetch<DocumentRecord>(
    `/api/agents/${agentId}/documents/${documentId}/index`,
    { method: 'POST' },
  )
}

export async function listProviders(): Promise<ProviderCatalog> {
  return apiFetch<ProviderCatalog>('/api/providers')
}

export async function listProviderConfigs(): Promise<ProviderConfigRecord[]> {
  return apiFetch<ProviderConfigRecord[]>('/api/provider-configs')
}

export async function createProviderConfig(
  input: Required<Pick<SaveProviderConfigInput, 'name' | 'type'>> & SaveProviderConfigInput,
): Promise<ProviderConfigRecord> {
  return apiFetch<ProviderConfigRecord>('/api/provider-configs', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export async function updateProviderConfig(
  id: number,
  input: SaveProviderConfigInput,
): Promise<ProviderConfigRecord> {
  return apiFetch<ProviderConfigRecord>(`/api/provider-configs/${id}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  })
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
    afterEventId?: number
    idempotencyKey?: string
    onEvent: (event: ParsedSseEvent) => void
  },
): Promise<StreamResult> {
  const idempotencyKey = options.idempotencyKey ?? crypto.randomUUID()
  const response = await fetch(apiUrl('/api/stream'), {
    method: 'POST',
    credentials: 'include',
    headers: authHeaders({
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
      ...(options.afterEventId
        ? { 'Last-Event-ID': String(options.afterEventId) }
        : {}),
    }),
    body: JSON.stringify(input),
    signal: options.signal,
  })

  if (!response.ok || !response.body) {
    throw await apiErrorFromResponse(response, 'Stream request failed')
  }

  return consumeStreamResponse(response, options.onEvent)
}

export async function streamPublicAgentRun(
  slug: string,
  input: { input: string; conversationId?: number },
  options: {
    signal?: AbortSignal
    afterEventId?: number
    idempotencyKey?: string
    onEvent: (event: ParsedSseEvent) => void
  },
): Promise<StreamResult> {
  const idempotencyKey = options.idempotencyKey ?? crypto.randomUUID()
  const response = await fetch(apiUrl(`/api/public/agents/${encodeURIComponent(slug)}/stream`), {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
      ...(options.afterEventId
        ? { 'Last-Event-ID': String(options.afterEventId) }
        : {}),
    },
    body: JSON.stringify(input),
    signal: options.signal,
  })

  if (!response.ok || !response.body) {
    throw await apiErrorFromResponse(response, 'Public stream request failed')
  }

  return consumeStreamResponse(response, options.onEvent)
}

export async function replayAgentRun(
  runId: number,
  afterEventId: number,
  options: {
    signal?: AbortSignal
    onEvent: (event: ParsedSseEvent) => void
  },
): Promise<StreamResult> {
  const response = await fetch(apiUrl(`/api/runs/${runId}/stream`), {
    credentials: 'include',
    headers: authHeaders({ 'Last-Event-ID': String(afterEventId) }),
    signal: options.signal,
  })
  if (!response.ok || !response.body) {
    throw await apiErrorFromResponse(response, 'Run replay failed')
  }
  return consumeStreamResponse(response, options.onEvent)
}

async function consumeStreamResponse(
  response: Response,
  onEvent: (event: ParsedSseEvent) => void,
): Promise<StreamResult> {
  if (!response.body) {
    throw new ApiError('Stream response body is unavailable', response.status)
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  const result: StreamResult = {
    runId: positiveHeader(response.headers.get('x-primalthrum-run-id')),
    conversationId: positiveHeader(response.headers.get('x-primalthrum-conversation-id')),
    idempotencyKey: response.headers.get('x-primalthrum-idempotency-key') ?? undefined,
  }
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
        if (parsed.id) result.lastEventId = parsed.id
        onEvent(parsed)
      }
    }
  }

  return result
}

function positiveHeader(value: string | null): number | undefined {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

interface ApiFetchInit extends RequestInit {
  auth?: boolean
  parseJson?: boolean
}

async function apiFetch<T>(path: string, init: ApiFetchInit = {}): Promise<T> {
  const {
    auth = true,
    parseJson = true,
    headers,
    ...requestInit
  } = init
  const requestHeaders = new Headers({ 'Content-Type': 'application/json' })
  new Headers(headers).forEach((value, key) => {
    requestHeaders.set(key, value)
  })

  const response = await fetch(apiUrl(path), {
    ...requestInit,
    credentials: 'include',
    headers: authHeaders(requestHeaders, auth),
  })

  if (!response.ok) {
    throw await apiErrorFromResponse(response, 'API request failed')
  }

  if (!parseJson || response.status === 204) {
    return undefined as T
  }

  return response.json() as Promise<T>
}

function parseSseBlock(block: string): ParsedSseEvent | null {
  const lines = block.split('\n')
  const event = lines
    .find((line) => line.startsWith('event:'))
    ?.replace('event:', '')
    .trim() ?? 'message'
  const id = positiveHeader(
    lines.find((line) => line.startsWith('id:'))?.replace('id:', '').trim() ?? null,
  )
  const data = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.replace('data:', '').trim())
    .join('')

  if (!data) {
    return null
  }

  try {
    return { id, event, data: JSON.parse(data) as StreamPayload }
  } catch {
    return null
  }
}

function apiUrl(path: string): string {
  return `${API_BASE_URL}${path}`
}

async function apiErrorFromResponse(response: Response, fallback: string): Promise<ApiError> {
  const parsed = await parseErrorBody(response)
  const message = parsed.message ?? `${fallback} with HTTP ${response.status}`
  const code = parsed.code ?? (response.status === 401 ? 'AUTHENTICATION_REQUIRED' : 'API_ERROR')

  if (response.status === 401) {
    return new UnauthorizedError(message, code)
  }

  return new ApiError(message, response.status, code, parsed.details)
}

async function parseErrorBody(response: Response): Promise<{
  code?: string
  message?: string
  details?: unknown
}> {
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    return {}
  }

  try {
    const body = await response.json() as {
      error?: string | {
        code?: unknown
        message?: unknown
        details?: unknown
      }
    }
    if (typeof body.error === 'string') {
      return { message: body.error }
    }
    if (body.error && typeof body.error === 'object') {
      return {
        code: typeof body.error.code === 'string' ? body.error.code : undefined,
        message: typeof body.error.message === 'string' ? body.error.message : undefined,
        details: body.error.details,
      }
    }
  } catch {
    return {}
  }

  return {}
}

function authHeaders(
  headers: HeadersInit,
  includeAuth = true,
): HeadersInit {
  const nextHeaders = new Headers(headers)
  const token = includeAuth ? getStoredSessionToken() : ''
  if (token) {
    nextHeaders.set('Authorization', `Bearer ${token}`)
  }
  return nextHeaders
}

function storeSessionToken(token: string): void {
  window.localStorage.setItem(SESSION_TOKEN_KEY, token)
}
