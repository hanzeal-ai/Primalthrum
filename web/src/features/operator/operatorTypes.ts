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

export interface OperatorCustomerUserSummary {
  userId: number
  userRef: string
  workspaceId: number
  workspaceName: string
  role: string
  status: string
  emailVerified: boolean
  mfaEnabled: boolean
  lastSessionAt: string | null
  createdAt: string
}

export interface OperatorSubscriptionSummary {
  workspaceId: number
  workspaceName: string
  planKey: string
  state: string
  pendingPlanKey: string
  provider: string
  periodStartsAt: string
  periodEndsAt: string | null
  trialEndsAt: string | null
  graceEndsAt: string | null
  cancelAtPeriodEnd: boolean
  updatedAt: string
}

export interface OperatorUsageSummary {
  workspaceId: number
  workspaceName: string
  meter: string
  quantity: number
  billableUnits: number
  creditsCharged: number
  providerCostMicros: number
  lastOccurredAt: string
}

export interface OperatorInvoiceSummary {
  id: number
  workspaceId: number
  workspaceName: string
  status: string
  currency: string
  amountDueMinor: number
  amountPaidMinor: number
  amountRefundedMinor: number
  dueAt: string | null
  paidAt: string | null
  createdAt: string
}

export interface OperatorRefundSummary {
  id: number
  workspaceId: number
  workspaceName: string
  status: string
  currency: string
  amountMinor: number
  createdAt: string
}

export interface OperatorWebhookFailureSummary {
  id: number
  provider: string
  eventType: string
  livemode: boolean
  workspaceId: number | null
  status: string
  attempts: number
  errorPresent: boolean
  receivedAt: string
  processedAt: string | null
}

export interface OperatorPaymentSummary {
  invoices: OperatorInvoiceSummary[]
  refunds: OperatorRefundSummary[]
  webhookFailures: OperatorWebhookFailureSummary[]
}

export interface OperatorAgentSummary {
  id: number
  agentRef: string
  workspaceId: number
  workspaceName: string
  status: string
  versionCount: number
  activeDeploymentCount: number
  previewVersionId: number | null
  publishedVersionId: number | null
  createdAt: string
  updatedAt: string
}

export interface OperatorJobSummary {
  id: number
  workspaceId: number
  workspaceName: string
  type: string
  status: string
  attempts: number
  maxAttempts: number
  hasError: boolean
  runAt: string
  startedAt: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface OperatorAbuseEventSummary {
  id: number
  eventId: string
  ruleKey: string
  action: string
  outcome: string
  retryAfterSeconds: number
  createdAt: string
}

export interface OperatorFeatureFlagOverride {
  id: number
  featureFlagId: number
  workspaceId: number
  workspaceName: string
  enabled: boolean
  reason: string
  active: boolean
  revision: number
  createdByOperatorId: number
  updatedByOperatorId: number
  createdAt: string
  updatedAt: string
}

export interface OperatorFeatureFlag {
  id: number
  key: string
  description: string
  enabled: boolean
  killSwitch: boolean
  rolloutPercentage: number
  revision: number
  createdByOperatorId: number
  updatedByOperatorId: number
  createdAt: string
  updatedAt: string
  overrides: OperatorFeatureFlagOverride[]
}

export interface OperatorFeatureFlagEvent {
  id: number
  eventId: string
  featureFlagId: number
  operatorUserId: number
  action: 'created' | 'updated' | 'override_created' | 'override_revoked'
  snapshot: Record<string, unknown>
  createdAt: string
}

export type OperatorIncidentSeverity = 'sev1' | 'sev2' | 'sev3' | 'sev4'
export type OperatorIncidentStatus = 'investigating' | 'identified' | 'monitoring' | 'resolved'
export type OperatorIncidentScope = 'platform' | 'multi_workspace' | 'workspace'
export type OperatorIncidentEventType = 'note' | 'mitigation' | 'customer_update'

export interface OperatorIncidentSummary {
  id: number
  incidentRef: string
  title: string
  severity: OperatorIncidentSeverity
  status: OperatorIncidentStatus
  impactScope: OperatorIncidentScope
  workspaceId: number | null
  workspaceName: string | null
  summary: string
  startedAt: string
  resolvedAt: string | null
  ownerOperatorId: number | null
  revision: number
  eventCount: number
  createdByOperatorId: number
  updatedByOperatorId: number
  createdAt: string
  updatedAt: string
}

export interface OperatorIncidentEvent {
  id: number
  eventId: string
  incidentId: number
  operatorUserId: number
  eventType: 'created' | 'updated' | 'status_changed' | OperatorIncidentEventType
  message: string
  fromStatus: string
  toStatus: string
  createdAt: string
}

export interface OperatorIncidentDetail extends OperatorIncidentSummary {
  events: OperatorIncidentEvent[]
}

export type LegalHoldBasis =
  | 'litigation'
  | 'regulatory'
  | 'investigation'
  | 'tax'
  | 'contractual'

export interface WorkspaceLegalHold {
  id: number
  holdRef: string
  workspaceId: number
  workspaceName: string
  externalCaseRef: string
  basis: LegalHoldBasis
  reason: string
  status: 'active' | 'released'
  revision: number
  createdByOperatorId: number
  releasedByOperatorId: number | null
  releaseReason: string
  releasedAt: string | null
  createdAt: string
  updatedAt: string
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
