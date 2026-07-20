import type {
  AgentRecord,
  AuthCredentials,
  AuthResponse,
  CreateAgentInput,
  CreateDocumentInput,
  CurrentSession,
  DocumentRecord,
  GeneratedProject,
  ParsedSseEvent,
  ProviderCatalog,
  ProviderConfigRecord,
  SaveProviderConfigInput,
  SetupStatus,
  SkillInfo,
  StreamAgentRequest,
  StreamPayload,
  ToolInfo,
} from './types'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? ''
const SESSION_TOKEN_KEY = 'primalthrum.sessionToken'

export class ApiError extends Error {
  readonly status: number

  constructor(
    message: string,
    status: number,
  ) {
    super(message)
    this.status = status
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message = 'Authentication required') {
    super(message, 401)
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
    onEvent: (event: ParsedSseEvent) => void
  },
): Promise<void> {
  const response = await fetch(apiUrl('/api/stream'), {
    method: 'POST',
    credentials: 'include',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(input),
    signal: options.signal,
  })

  if (!response.ok || !response.body) {
    if (response.status === 401) {
      throw new UnauthorizedError()
    }
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
    if (response.status === 401) {
      throw new UnauthorizedError()
    }
    throw new ApiError(`API request failed with HTTP ${response.status}`, response.status)
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
