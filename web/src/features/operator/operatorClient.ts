import type {
  OperatorAuditRecord,
  OperatorAuthResponse,
  OperatorOverviewResponse,
  OperatorSetupStatus,
  OperatorUser,
  OperatorWorkspaceSummary,
  SupportAccessGrant,
  SupportGrantPermission,
} from './operatorTypes'

const OPERATOR_TOKEN_KEY = 'primalthrum.operatorSessionToken'

export class OperatorApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(
    message: string,
    status: number,
    code: string,
  ) {
    super(message)
    this.status = status
    this.code = code
  }
}

export function getOperatorSetupStatus(): Promise<OperatorSetupStatus> {
  return operatorRequest('/api/operator/setup/status', { auth: false })
}

export async function setupOperator(input: {
  email: string
  password: string
  bootstrapToken: string
}): Promise<OperatorAuthResponse> {
  const response = await operatorRequest<OperatorAuthResponse>('/api/operator/setup', {
    auth: false,
    method: 'POST',
    headers: { 'X-Operator-Bootstrap-Token': input.bootstrapToken },
    body: JSON.stringify({ email: input.email, password: input.password }),
  })
  storeOperatorToken(response.session.token)
  return response
}

export async function loginOperator(input: {
  email: string
  password: string
}): Promise<OperatorAuthResponse> {
  const response = await operatorRequest<OperatorAuthResponse>('/api/operator/auth/login', {
    auth: false,
    method: 'POST',
    body: JSON.stringify(input),
  })
  storeOperatorToken(response.session.token)
  return response
}

export function getOperatorSession(): Promise<{ user: OperatorUser; expiresAt: string }> {
  return operatorRequest('/api/operator/auth/session')
}

export async function logoutOperator(): Promise<void> {
  try {
    await operatorRequest('/api/operator/auth/logout', { method: 'POST' })
  } finally {
    clearOperatorToken()
  }
}

export async function changeOperatorPassword(input: {
  currentPassword: string
  password: string
}): Promise<OperatorAuthResponse> {
  const response = await operatorRequest<OperatorAuthResponse>('/api/operator/auth/password', {
    method: 'PUT',
    body: JSON.stringify(input),
  })
  storeOperatorToken(response.session.token)
  return response
}

export function getOperatorOverview(): Promise<OperatorOverviewResponse> {
  return operatorRequest('/api/operator/overview')
}

export function listOperatorWorkspaces(): Promise<OperatorWorkspaceSummary[]> {
  return operatorRequest('/api/operator/workspaces')
}

export function listOperators(): Promise<OperatorUser[]> {
  return operatorRequest('/api/operator/operators')
}

export function createOperator(input: {
  email: string
  password: string
  role: OperatorUser['role']
}): Promise<OperatorUser> {
  return operatorRequest('/api/operator/operators', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function listSupportGrants(): Promise<SupportAccessGrant[]> {
  return operatorRequest('/api/operator/support-grants')
}

export function createSupportGrant(input: {
  workspaceId: number
  operatorUserId: number
  permissions: SupportGrantPermission[]
  reason: string
  ticketRef: string
  expiresAt: string
}): Promise<SupportAccessGrant> {
  return operatorRequest('/api/operator/support-grants', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function revokeSupportGrant(id: number): Promise<SupportAccessGrant> {
  return operatorRequest(`/api/operator/support-grants/${id}`, { method: 'DELETE' })
}

export function getSupportContext(id: number): Promise<{
  grant: SupportAccessGrant
  context: Record<string, unknown>
}> {
  return operatorRequest(`/api/operator/support-grants/${id}/context`)
}

export function listOperatorAudit(): Promise<OperatorAuditRecord[]> {
  return operatorRequest('/api/operator/audit?limit=200')
}

export function getStoredOperatorToken(): string {
  return window.localStorage.getItem(OPERATOR_TOKEN_KEY) ?? ''
}

export function clearOperatorToken(): void {
  window.localStorage.removeItem(OPERATOR_TOKEN_KEY)
}

function storeOperatorToken(token: string): void {
  window.localStorage.setItem(OPERATOR_TOKEN_KEY, token)
}

async function operatorRequest<T = void>(
  path: string,
  options: RequestInit & { auth?: boolean } = {},
): Promise<T> {
  const headers = new Headers(options.headers)
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  if (options.auth !== false) {
    const token = getStoredOperatorToken()
    if (token) headers.set('authorization', `Bearer ${token}`)
  }
  const response = await fetch(path, { ...options, headers })
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as {
      error?: { code?: string; message?: string }
    } | null
    throw new OperatorApiError(
      payload?.error?.message ?? `Operator API returned ${response.status}`,
      response.status,
      payload?.error?.code ?? 'OPERATOR_API_ERROR',
    )
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}
