export type OperatorRole = 'super_admin' | 'support' | 'billing' | 'security' | 'viewer'

export interface OperatorUser {
  id: number
  email: string
  role: OperatorRole
  status: 'active' | 'disabled'
  mustChangePassword: boolean
  lastLoginAt: string | null
  createdAt: string
}

export interface OperatorSession {
  token: string
  expiresAt: string
}

export interface OperatorAuthResponse {
  user: OperatorUser
  session: OperatorSession
}

export interface OperatorSetupStatus {
  needsSetup: boolean
  setupEnabled: boolean
}

export interface OperatorOverview {
  workspaces: number
  users: number
  activeSubscriptions: number
  agents: number
  failedJobs: number
  failedPayments: number
  abuseEnforcements: number
  activeSupportGrants: number
  monthlyCredits: number
  monthlyProviderCostMicros: number
}

export interface OperatorReadiness {
  status: 'ready' | 'not_ready'
  service: string
  checks: Array<{
    name: string
    status: 'ok' | 'failed'
    latencyMs: number
    message?: string
  }>
}

export interface OperatorOverviewResponse {
  overview: OperatorOverview
  readiness: OperatorReadiness
}

export interface OperatorWorkspaceSummary {
  id: number
  name: string
  slug: string
  memberCount: number
  agentCount: number
  failedJobCount: number
  planKey: string
  subscriptionState: string
  periodCredits: number
  periodProviderCostMicros: number
  createdAt: string
}

export type SupportGrantPermission =
  | 'workspace.metadata.read'
  | 'workspace.agents.read'
  | 'workspace.jobs.read'
  | 'workspace.billing.read'

export interface SupportAccessGrant {
  id: number
  workspaceId: number
  operatorUserId: number
  permissions: SupportGrantPermission[]
  reason: string
  ticketRef: string
  expiresAt: string
  revokedAt: string | null
  createdByOperatorId: number
  createdAt: string
  status: 'active' | 'expired' | 'revoked'
}

export interface OperatorAuditRecord {
  id: number
  eventId: string
  operatorUserId: number | null
  eventType: string
  targetType: string
  targetId: string
  metadata: Record<string, unknown>
  createdAt: string
}
