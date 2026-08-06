import type {
  OperatorAbuseEventSummary,
  OperatorAgentSummary,
  OperatorAuditRecord,
  OperatorAuthResponse,
  OperatorCustomerUserSummary,
  OperatorFeatureFlag,
  OperatorFeatureFlagEvent,
  OperatorFeatureFlagOverride,
  OperatorIncidentDetail,
  OperatorIncidentEvent,
  OperatorIncidentEventType,
  OperatorIncidentScope,
  OperatorIncidentSeverity,
  OperatorIncidentStatus,
  OperatorIncidentSummary,
  OperatorJobSummary,
  LegalHoldBasis,
  OperatorOverviewResponse,
  OperatorPaymentSummary,
  OperatorSetupStatus,
  OperatorSubscriptionSummary,
  OperatorUser,
  OperatorUsageSummary,
  OperatorWorkspaceSummary,
  WorkspaceLegalHold,
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

export function listOperatorCustomerUsers(): Promise<OperatorCustomerUserSummary[]> {
  return operatorRequest('/api/operator/customer-users')
}

export function listOperatorSubscriptions(): Promise<OperatorSubscriptionSummary[]> {
  return operatorRequest('/api/operator/subscriptions')
}

export function listOperatorUsage(): Promise<OperatorUsageSummary[]> {
  return operatorRequest('/api/operator/usage')
}

export function listOperatorPayments(): Promise<OperatorPaymentSummary> {
  return operatorRequest('/api/operator/payments')
}

export function listOperatorAgents(): Promise<OperatorAgentSummary[]> {
  return operatorRequest('/api/operator/agents')
}

export function listOperatorJobs(): Promise<OperatorJobSummary[]> {
  return operatorRequest('/api/operator/jobs')
}

export function listOperatorAbuseEvents(): Promise<OperatorAbuseEventSummary[]> {
  return operatorRequest('/api/operator/abuse-events')
}

export function listOperatorLegalHolds(): Promise<WorkspaceLegalHold[]> {
  return operatorRequest('/api/operator/legal-holds')
}

export function createOperatorLegalHold(input: {
  workspaceId: number
  externalCaseRef: string
  basis: LegalHoldBasis
  reason: string
}): Promise<WorkspaceLegalHold> {
  return operatorRequest('/api/operator/legal-holds', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function releaseOperatorLegalHold(
  id: number,
  input: { expectedRevision: number; releaseReason: string },
): Promise<WorkspaceLegalHold> {
  return operatorRequest(`/api/operator/legal-holds/${id}/release`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function listOperatorFeatureFlags(): Promise<OperatorFeatureFlag[]> {
  return operatorRequest('/api/operator/feature-flags')
}

export function createOperatorFeatureFlag(input: {
  key: string
  description: string
  enabled: boolean
  killSwitch: boolean
  rolloutPercentage: number
}): Promise<OperatorFeatureFlag> {
  return operatorRequest('/api/operator/feature-flags', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function updateOperatorFeatureFlag(
  id: number,
  input: {
    description: string
    enabled: boolean
    killSwitch: boolean
    rolloutPercentage: number
    expectedRevision: number
  },
): Promise<OperatorFeatureFlag> {
  return operatorRequest(`/api/operator/feature-flags/${id}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  })
}

export function listOperatorFeatureFlagEvents(id: number): Promise<OperatorFeatureFlagEvent[]> {
  return operatorRequest(`/api/operator/feature-flags/${id}/events`)
}

export function createOperatorFeatureFlagOverride(
  flagId: number,
  input: { workspaceId: number; enabled: boolean; reason: string },
): Promise<OperatorFeatureFlagOverride> {
  return operatorRequest(`/api/operator/feature-flags/${flagId}/overrides`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function revokeOperatorFeatureFlagOverride(
  flagId: number,
  overrideId: number,
  expectedRevision: number,
): Promise<OperatorFeatureFlagOverride> {
  return operatorRequest(`/api/operator/feature-flags/${flagId}/overrides/${overrideId}/revoke`, {
    method: 'POST',
    body: JSON.stringify({ expectedRevision }),
  })
}

export function listOperatorIncidents(): Promise<OperatorIncidentSummary[]> {
  return operatorRequest('/api/operator/incidents')
}

export function getOperatorIncident(id: number): Promise<OperatorIncidentDetail> {
  return operatorRequest(`/api/operator/incidents/${id}`)
}

export function createOperatorIncident(input: {
  title: string
  severity: OperatorIncidentSeverity
  impactScope: OperatorIncidentScope
  workspaceId: number | null
  summary: string
  startedAt: string
  ownerOperatorId: number | null
}): Promise<OperatorIncidentDetail> {
  return operatorRequest('/api/operator/incidents', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function updateOperatorIncident(
  id: number,
  input: {
    title: string
    severity: OperatorIncidentSeverity
    status: OperatorIncidentStatus
    impactScope: OperatorIncidentScope
    workspaceId: number | null
    summary: string
    ownerOperatorId: number | null
    expectedRevision: number
  },
): Promise<OperatorIncidentDetail> {
  return operatorRequest(`/api/operator/incidents/${id}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  })
}

export function createOperatorIncidentEvent(
  id: number,
  input: { eventType: OperatorIncidentEventType; message: string },
): Promise<OperatorIncidentEvent> {
  return operatorRequest(`/api/operator/incidents/${id}/events`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
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
