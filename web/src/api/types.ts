export type RunStatus = 'idle' | 'running' | 'done' | 'error'

export interface AbuseProtectionConfig {
  provider: 'disabled' | 'turnstile'
  siteKey: string
  actions: Array<'auth_register' | 'public_agent_stream'>
}

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

export type WorkspaceRole = 'owner' | 'admin' | 'developer' | 'member' | 'billing' | 'viewer'

export interface AuthUser {
  id: number
  workspaceId: number
  email: string
  role: WorkspaceRole
}

export interface AuthSession {
  token: string
  expiresAt: string
}

export interface AuthResponse {
  user: AuthUser
  session: AuthSession
  emailVerified: boolean
}

export type ApiKeyScope = 'agents:read' | 'agents:write' | 'agents:run' | 'agents:publish'

export interface WorkspaceApiKeyRecord {
  id: number
  workspaceId: number
  name: string
  keyPrefix: string
  scopes: ApiKeyScope[]
  createdByUserId: number | null
  expiresAt: string
  lastUsedAt: string | null
  lastUsedMethod: string
  lastUsedPath: string
  revokedAt: string | null
  createdAt: string
}

export interface CreatedWorkspaceApiKey extends WorkspaceApiKeyRecord {
  token: string
}

export interface SessionSecurityRecord {
  id: number
  current: boolean
  expiresAt: string
  lastSeenAt: string
  createdAt: string
}

export interface RetentionPolicyRecord {
  workspaceId: number
  conversationDays: number | null
  runDays: number | null
  documentDays: number | null
  updatedByUserId: number | null
  lastEnforcedAt: string | null
  nextEnforcementAt: string | null
  createdAt: string
  updatedAt: string
}

export interface RetentionPreview {
  conversations: number
  runs: number
  documents: number
  documentBytes: number
}

export interface RetentionEventRecord {
  id: number
  workspaceId: number
  eventType: 'policy_updated' | 'enforcement_completed'
  actorUserId: number | null
  policy: Pick<RetentionPolicyRecord, 'conversationDays' | 'runDays' | 'documentDays'>
  result: Record<string, unknown>
  createdAt: string
}

export interface RetentionSettingsState {
  policy: RetentionPolicyRecord
  preview: RetentionPreview
  events: RetentionEventRecord[]
  customRetentionEnabled: boolean
  canManage: boolean
}

export interface RetentionEnforcementOutcome {
  event: RetentionEventRecord
  filesDeleted: number
  fileDeletionFailures: number
}

export interface RegistrationInput extends AuthCredentials {
  workspaceName: string
  planKey: 'free' | 'pro'
}

export interface RegistrationResponse extends AuthResponse {
  workspace: Omit<WorkspaceRecord, 'role'>
  verificationRequired: boolean
  emailPreviewUrl?: string
  entitlementSnapshot: {
    workspaceId: number
    planKey: string
    subscriptionState: string
  }
  creditAccount: {
    workspaceId: number
    availableCredits: number
    reservedCredits: number
    spentCredits: number
  }
}

export interface PublicPlanRecord {
  key: string
  name: string
  status: string
  currency: string
  monthlyPriceMinor: number
  monthlyCreditGrant: number
  trialCreditGrant: number
  trialDays: number
  overageEnabled: boolean
  metadata: Record<string, unknown>
  entitlements: Array<{
    feature: string
    enabled: boolean
    quantityLimit: number | null
    source: string
  }>
}

export interface BillingEntitlementRecord {
  feature: string
  enabled: boolean
  quantityLimit: number | null
  source: string
}

export interface BillingEntitlementSnapshot {
  workspaceId: number
  planKey: string
  subscriptionState: string
  generatedAt: string
  entitlements: Record<string, BillingEntitlementRecord>
}

export interface CreditAccountRecord {
  workspaceId: number
  availableCredits: number
  reservedCredits: number
  spentCredits: number
  updatedAt: string
}

export interface WorkspaceSubscriptionRecord {
  workspaceId: number
  planKey: string
  state: 'trialing' | 'active' | 'past_due' | 'restricted' | 'cancel_at_period_end' | 'canceled' | 'refunded'
  periodStartsAt: string
  periodEndsAt: string | null
  trialEndsAt: string | null
  cancelAtPeriodEnd: boolean
  provider: string
  providerCustomerRef: string
  providerSubscriptionRef: string
  providerPriceRef: string
  providerSubscriptionItemRef: string
  pendingPlanKey: string
  graceEndsAt: string | null
  canceledAt: string | null
}

export interface BillingInvoiceRecord {
  id: number
  workspaceId: number
  provider: string
  providerInvoiceRef: string
  status: string
  currency: string
  amountDueMinor: number
  amountPaidMinor: number
  amountRefundedMinor: number
  periodStartsAt: string | null
  periodEndsAt: string | null
  hostedInvoiceUrl: string
  invoicePdfUrl: string
  dueAt: string | null
  paidAt: string | null
  createdAt: string
  updatedAt: string
}

export interface BillingSummary {
  entitlementSnapshot: BillingEntitlementSnapshot
  creditAccount: CreditAccountRecord
  subscription: WorkspaceSubscriptionRecord
  invoices: BillingInvoiceRecord[]
}

export interface BillingCheckoutRecord {
  id?: number
  workspaceId?: number
  provider?: string
  planKey?: string
  status?: string
  checkoutUrl: string
  expiresAt?: string | null
}

export interface BillingCostControls {
  workspaceId: number
  monthlyCreditLimit: number | null
  monthlyProviderCostMicrosLimit: number | null
  hardLimit: boolean
  overageEnabled: boolean
  alertThresholds: number[]
}

export interface BillingCostControlInput {
  monthlyCreditLimit: number | null
  monthlyProviderCostMicrosLimit: number | null
  hardLimit: boolean
  overageEnabled: boolean
  alertThresholds: number[]
}

export interface BillingUsageSummary {
  workspaceId: number
  periodStartsAt: string
  periodEndsAt: string
  creditsCharged: number
  providerCostMicros: number
  eventCount: number
  byMeter: Array<{
    meter: string
    quantity: number
    creditsCharged: number
    providerCostMicros: number
  }>
  controls: BillingCostControls
}

export interface BillingCostAlert {
  id: number
  workspaceId: number
  periodKey: string
  thresholdPercent: number
  metric: string
  currentValue: number
  limitValue: number
  status: string
  createdAt: string
  deliveredAt: string | null
}

export interface CurrentSession {
  user: AuthUser
  expiresAt: string
  emailVerified: boolean
}

export interface VerificationDispatchResponse {
  accepted: boolean
  emailPreviewUrl?: string
}

export interface PrivacyConfig {
  policyVersion: string
  categories: {
    necessary: { required: true }
    analytics: { required: false; default: false }
  }
}

export interface PrivacyConsentReceipt {
  receiptId: string
  policyVersion: string
  necessary: true
  analytics: boolean
  action: 'granted' | 'denied' | 'withdrawn'
  recordedAt: string
}

export type AnalyticsEventName =
  | 'page_view'
  | 'agent_intent_started'
  | 'plan_selected'
  | 'signup_viewed'
  | 'signup_submitted'
  | 'signup_completed'
  | 'email_verification_completed'

export interface AnalyticsEventInput {
  subjectId: string
  consentReceiptId: string
  eventId: string
  eventName: AnalyticsEventName
  path: string
  properties: Record<string, string | boolean>
  occurredAt: string
}

export interface WorkspaceRecord {
  id: number
  name: string
  slug: string
  role: WorkspaceRole
  createdAt: string
  updatedAt: string
}

export interface WorkspaceMemberRecord {
  id: number
  workspaceId: number
  userId: number
  email: string
  role: WorkspaceRole
  status: string
  createdAt: string
  updatedAt: string
}

export interface WorkspaceInvitationRecord {
  id: number
  workspaceId: number
  email: string
  role: WorkspaceRole
  expiresAt: string
  acceptedAt: string | null
  revokedAt: string | null
  createdAt: string
}

export interface CreatedWorkspaceInvitation extends WorkspaceInvitationRecord {
  token: string
  acceptUrl: string
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
