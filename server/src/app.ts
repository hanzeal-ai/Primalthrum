import Koa from 'koa';
import Router from '@koa/router';
import bodyParser from 'koa-bodyparser';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { type DatabaseAdapter } from './db/adapter';
import { type AsyncDatabaseAdapter } from './db/asyncAdapter';
import { AsyncSqliteDatabase } from './db/asyncSqlite';
import { createSqliteDatabase, initializeDatabase } from './db/databaseFactory';
import { DisabledDatabase } from './db/disabled';
import { generateAgentProject } from './generators/agentProjectGenerator';
import {
  AgentRepository,
  type AgentRecord,
  type CreateAgentInput,
} from './services/agentRepository';
import { AsyncAgentRepository } from './services/asyncAgentRepository';
import { type AgentStore } from './services/agentStore';
import { registerAppCleanup } from './services/appLifecycle';
import { AgentVersionRepository } from './services/agentVersionRepository';
import { AsyncAgentVersionRepository } from './services/asyncAgentVersionRepository';
import { type AgentVersionStore } from './services/agentVersionStore';
import { sendApiError } from './services/apiErrors';
import {
  capabilityKey,
  fetchCapabilityCatalog,
} from './services/capabilityCatalogClient';
import {
  CapabilityDisabledError,
  CapabilitySettingsRepository,
} from './services/capabilitySettingsRepository';
import { AsyncCapabilitySettingsRepository } from './services/asyncCapabilitySettingsRepository';
import { type CapabilitySettingsStore } from './services/capabilitySettingsStore';
import {
  ConversationRepository,
  type ConversationSource,
} from './services/conversationRepository';
import { AsyncConversationRepository } from './services/asyncConversationRepository';
import { type ConversationStore } from './services/conversationStore';
import {
  clearSessionCookie,
  createAuthMiddleware,
  extractSessionToken,
  sessionCookie,
} from './services/authMiddleware';
import {
  DocumentRepository,
  type CreateDocumentInput,
  type DocumentRecord,
} from './services/documentRepository';
import { AsyncDocumentRepository } from './services/asyncDocumentRepository';
import { type DocumentStore } from './services/documentStore';
import { AgentEmbeddingClient } from './services/agentEmbeddingClient';
import { fetchAgent } from './services/agentHttpClient';
import { AgentSpeechClient } from './services/agentSpeechClient';
import { chunkDocumentText } from './services/documentChunker';
import { DocumentIndexRepository } from './services/documentIndexRepository';
import { AsyncDocumentIndexRepository } from './services/asyncDocumentIndexRepository';
import { type DocumentIndexStore } from './services/documentIndexStore';
import {
  parseDocumentUpload,
  type ParsedDocumentUpload,
} from './services/documentUpload';
import {
  createDocumentMalwareScanner,
  type DocumentMalwareScanner,
  DocumentScanUnavailableError,
  DocumentThreatDetectedError,
} from './services/documentMalwareScanner';
import { DocumentUploadSecurityRepository } from './services/documentUploadSecurityRepository';
import { AsyncDocumentUploadSecurityRepository } from './services/asyncDocumentUploadSecurityRepository';
import { type DocumentUploadSecurityStore } from './services/documentUploadSecurityStore';
import { DocumentUploadSecurityService } from './services/documentUploadSecurityService';
import { DurableJobDispatcher } from './services/durableJobDispatcher';
import {
  type DocumentFileStorage,
  LocalDocumentStorage,
} from './services/fileStorage';
import { checkServerReadiness } from './services/healthReadiness';
import { type HttpTraceExporter } from './services/httpTraceExporter';
import { createHttpTracingMiddleware } from './services/httpTracingMiddleware';
import { JsonConsoleLogger, type StructuredLogger } from './services/logger';
import { MetricsRegistry } from './services/metricsRegistry';
import { hashPassword, verifyPassword, verifyPasswordOrDummy } from './services/passwordHash';
import { JobRepository } from './services/jobRepository';
import { AsyncJobRepository } from './services/asyncJobRepository';
import { DEFAULT_JOB_LEASE_DURATION_MS, type JobStore } from './services/jobStore';
import {
  ProviderConfigRepository,
  type CreateProviderConfigInput,
  type UpdateProviderConfigInput,
} from './services/providerConfigRepository';
import { AsyncProviderConfigRepository } from './services/asyncProviderConfigRepository';
import { type ProviderConfigStore } from './services/providerConfigStore';
import { listProviders, listSkills, listTools } from './services/discoveryCatalog';
import {
  RunRepository,
  type CreateRunInput,
  type RunRecord,
} from './services/runRepository';
import { AsyncRunRepository } from './services/asyncRunRepository';
import { type RunStore } from './services/runStore';
import { SessionRepository } from './services/sessionRepository';
import { AsyncSessionRepository } from './services/asyncSessionRepository';
import { type SessionStore } from './services/sessionStore';
import { formatSseEvent, pipeSseStream } from './services/sseRecorder';
import {
  StreamEventRepository,
  type CreateStreamEventInput,
} from './services/streamEventRepository';
import { AsyncStreamEventRepository } from './services/asyncStreamEventRepository';
import { type StreamEventStore } from './services/streamEventStore';
import { ToolAuditRepository } from './services/toolAuditRepository';
import { AsyncToolAuditRepository } from './services/asyncToolAuditRepository';
import { type ToolAuditStore } from './services/toolAuditStore';
import {
  capabilityKeysForConfig,
  resolveStreamRequest,
  StreamRequestError,
} from './services/streamRequestResolver';
import {
  normalizeEmail,
  UserRepository,
} from './services/userRepository';
import { AsyncUserRepository } from './services/asyncUserRepository';
import { type UserStore } from './services/userStore';
import { WorkspaceRepository } from './services/workspaceRepository';
import { AsyncWorkspaceRepository } from './services/asyncWorkspaceRepository';
import { type WorkspaceStore } from './services/workspaceStore';
import { WorkspaceOwnershipRepository } from './services/workspaceOwnershipRepository';
import { AsyncWorkspaceOwnershipRepository } from './services/asyncWorkspaceOwnershipRepository';
import { type WorkspaceOwnershipStore } from './services/workspaceOwnershipStore';
import { WorkspaceLegalHoldRepository } from './services/workspaceLegalHoldRepository';
import { AsyncSecretVault } from './services/asyncSecretVault';
import { LocalSecretVault } from './services/localSecretVault';
import { type SecretStore } from './services/secretStore';
import { RuntimeProviderResolver } from './services/runtimeProviderResolver';
import { RuntimeSpeechResolver } from './services/runtimeSpeechResolver';
import { BillingError, BillingRepository } from './services/billingRepository';
import { AsyncBillingRepository } from './services/asyncBillingRepository';
import { type BillingStore } from './services/billingStore';
import { PaymentLifecycleRepository } from './services/paymentLifecycleRepository';
import { AsyncPaymentLifecycleRepository } from './services/asyncPaymentLifecycleRepository';
import { type PaymentLifecycleStore } from './services/paymentLifecycleStore';
import { type PaymentProviderAdapter } from './services/paymentProvider';
import { PaymentWebhookProcessor } from './services/paymentWebhookProcessor';
import { registerBillingRoutes } from './routes/billingRoutes';
import { registerSpeechRoutes } from './routes/speechRoutes';
import { UsageRatingRepository } from './services/usageRatingRepository';
import { AsyncUsageRatingRepository } from './services/asyncUsageRatingRepository';
import { type UsageRatingStore } from './services/usageRatingStore';
import { RunUsageService } from './services/runUsageService';
import { UsageRatingError } from './services/usageRatingTypes';
import {
  MeteredOperationService,
  type MeteredOperation,
} from './services/meteredOperationService';
import { UsageExportOutboxRepository } from './services/usageExportOutboxRepository';
import { AsyncUsageExportOutboxRepository } from './services/asyncUsageExportOutboxRepository';
import { type UsageExportOutboxStore } from './services/usageExportOutboxStore';
import { UsageExportDispatcher } from './services/usageExportDispatcher';
import { type UsageMeterExporter } from './services/usageMeterExporter';
import { type WorkerTraceExporter } from './services/workerTraceExporter';
import { OutboxDispatcherLifecycle } from './services/outboxDispatcherLifecycle';
import { AsyncCreditLedgerRepository } from './services/asyncCreditLedgerRepository';
import { CreditLedgerRepository } from './services/creditLedgerRepository';
import { type CreditLedgerStore } from './services/creditLedgerStore';
import { AccountTokenRepository } from './services/accountTokenRepository';
import { AsyncAccountTokenRepository } from './services/asyncAccountTokenRepository';
import { AccountOnboardingRepository } from './services/accountOnboardingRepository';
import { AsyncAccountOnboardingRepository } from './services/asyncAccountOnboardingRepository';
import { AccountEmailOutboxRepository } from './services/accountEmailOutboxRepository';
import { AsyncAccountEmailOutboxRepository } from './services/asyncAccountEmailOutboxRepository';
import { type AccountEmailOutboxStore } from './services/accountEmailOutboxStore';
import { AccountEmailDispatcher } from './services/accountEmailDispatcher';
import { type AccountEmailSender } from './services/accountEmailSender';
import { AccountIdentityService } from './services/accountIdentityService';
import { AccountDataExportService } from './services/accountDataExportService';
import { AsyncAccountDataExportService } from './services/asyncAccountDataExportService';
import { type AccountDataExportStore } from './services/accountDataExportStore';
import { AccountDeletionService } from './services/accountDeletionService';
import { AsyncAccountDeletionService } from './services/asyncAccountDeletionService';
import { type AccountDeletionStore } from './services/accountDeletionStore';
import { AccountPrivacyRepository } from './services/accountPrivacyRepository';
import { AsyncAccountPrivacyRepository } from './services/asyncAccountPrivacyRepository';
import { type AccountPrivacyStore } from './services/accountPrivacyStore';
import { AccountPrivacyScheduler } from './services/accountPrivacyScheduler';
import { PrivacyAnalyticsRepository } from './services/privacyAnalyticsRepository';
import { AsyncPrivacyAnalyticsRepository } from './services/asyncPrivacyAnalyticsRepository';
import { type PrivacyAnalyticsStore } from './services/privacyAnalyticsStore';
import { registerPrivacyRoutes } from './routes/privacyRoutes';
import { registerAccountEmailRoutes } from './routes/accountEmailRoutes';
import { type AccountEmailWebhookVerifier } from './services/accountEmailWebhook';
import { AbuseProtectionService } from './services/abuseProtection';
import { AbuseProtectionRepository } from './services/abuseProtectionRepository';
import { AsyncAbuseProtectionRepository } from './services/asyncAbuseProtectionRepository';
import { type BotChallengeVerifier } from './services/botChallengeVerifier';
import { registerAbuseRoutes } from './routes/abuseRoutes';
import { registerSecuritySettingsRoutes } from './routes/securitySettingsRoutes';
import { registerRetentionSettingsRoutes } from './routes/retentionSettingsRoutes';
import { registerMfaRoutes } from './routes/mfaRoutes';
import { registerOperatorChangeRoutes } from './routes/operatorChangeRoutes';
import { registerOperatorDomainRoutes } from './routes/operatorDomainRoutes';
import { registerOperatorLegalHoldRoutes } from './routes/operatorLegalHoldRoutes';
import { registerOperatorRoutes } from './routes/operatorRoutes';
import { registerWorkspaceOwnershipRoutes } from './routes/workspaceOwnershipRoutes';
import { ApiKeyRepository } from './services/apiKeyRepository';
import { AsyncApiKeyRepository } from './services/asyncApiKeyRepository';
import { type ApiKeyStore } from './services/apiKeyStore';
import { MfaRepository } from './services/mfaRepository';
import { AsyncMfaRepository } from './services/asyncMfaRepository';
import { MfaService } from './services/mfaService';
import { RetentionPolicyRepository } from './services/retentionPolicyRepository';
import { AsyncRetentionPolicyRepository } from './services/asyncRetentionPolicyRepository';
import { type RetentionPolicyStore } from './services/retentionPolicyStore';
import { RetentionScheduler } from './services/retentionScheduler';
import { RetentionService } from './services/retentionService';
import {
  apiKeyScopeForPermission,
  hasWorkspacePermission,
  type WorkspacePermission,
} from './services/workspaceAuthorization';
import { OperatorIdentityRepository } from './services/operatorIdentityRepository';
import { AsyncOperatorIdentityRepository } from './services/asyncOperatorIdentityRepository';
import { type OperatorIdentityStore } from './services/operatorIdentityStore';
import { OperatorAuditRepository } from './services/operatorAuditRepository';
import { AsyncOperatorAuditRepository } from './services/asyncOperatorAuditRepository';
import { type OperatorAuditStore } from './services/operatorAuditStore';
import { OperatorBillingReadRepository } from './services/operatorBillingReadRepository';
import { AsyncOperatorBillingReadRepository } from './services/asyncOperatorBillingReadRepository';
import { type OperatorBillingReadStore } from './services/operatorBillingReadStore';
import { OperatorCustomerReadRepository } from './services/operatorCustomerReadRepository';
import { AsyncOperatorCustomerReadRepository } from './services/asyncOperatorCustomerReadRepository';
import { type OperatorCustomerReadStore } from './services/operatorCustomerReadStore';
import { OperatorFeatureFlagRepository } from './services/operatorFeatureFlagRepository';
import { AsyncOperatorFeatureFlagRepository } from './services/asyncOperatorFeatureFlagRepository';
import { type OperatorFeatureFlagStore } from './services/operatorFeatureFlagStore';
import { OperatorIncidentRepository } from './services/operatorIncidentRepository';
import { AsyncOperatorIncidentRepository } from './services/asyncOperatorIncidentRepository';
import { type OperatorIncidentStore } from './services/operatorIncidentStore';
import { OperatorReadRepository } from './services/operatorReadRepository';
import { AsyncOperatorReadRepository } from './services/asyncOperatorReadRepository';
import { type OperatorReadStore } from './services/operatorReadStore';
import { OperatorRuntimeReadRepository } from './services/operatorRuntimeReadRepository';
import { AsyncOperatorRuntimeReadRepository } from './services/asyncOperatorRuntimeReadRepository';
import { type OperatorRuntimeReadStore } from './services/operatorRuntimeReadStore';
import { OperatorSecurityReadRepository } from './services/operatorSecurityReadRepository';
import { AsyncOperatorSecurityReadRepository } from './services/asyncOperatorSecurityReadRepository';
import { type OperatorSecurityReadStore } from './services/operatorSecurityReadStore';
import { SupportAccessRepository } from './services/supportAccessRepository';
import { AsyncSupportAccessRepository } from './services/asyncSupportAccessRepository';
import { type SupportAccessStore } from './services/supportAccessStore';
import { AsyncWorkspaceLegalHoldRepository } from './services/asyncWorkspaceLegalHoldRepository';
import { type WorkspaceLegalHoldStore } from './services/workspaceLegalHoldStore';

export interface AppOptions {
  accountDeletionGracePeriodMs?: number;
  accountPrivacyNow?: () => Date;
  accountPrivacySchedulerIntervalMs?: number;
  backgroundTimersUnref?: boolean;
  jobLeaseDurationMs?: number;
  jobPollIntervalMs?: number;
  startBackgroundSchedulers?: boolean;
  agentBaseUrl?: string;
  dbPath?: string;
  database?: DatabaseAdapter;
  identityDatabase?: AsyncDatabaseAdapter;
  runtimeDatabase?: AsyncDatabaseAdapter;
  documentMalwareScanner?: DocumentMalwareScanner;
  documentStorage?: DocumentFileStorage;
  documentStorageDir?: string;
  generatedAgentsDir?: string;
  logger?: StructuredLogger;
  metrics?: MetricsRegistry;
  traceExporter?: HttpTraceExporter;
  workerTraceExporter?: WorkerTraceExporter;
  paymentAdapter?: PaymentProviderAdapter;
  paymentPriceRefs?: Record<string, string>;
  publicAppUrl?: string;
  stripeWebhookSecret?: string;
  usageMeterExporter?: UsageMeterExporter;
  accountEmailSender?: AccountEmailSender;
  accountEmailWebhookVerifier?: AccountEmailWebhookVerifier;
  exposeAccountEmailPreview?: boolean;
  abuseProtection?: AbuseProtectionService;
  abuseHashSecret?: string;
  botChallengeVerifier?: BotChallengeVerifier;
  botChallengeSiteKey?: string;
  trustedProxyHops?: number;
  operatorBootstrapToken?: string;
}

const DEFAULT_AGENT_BASE_URL = 'http://127.0.0.1:8000';
const DEFAULT_DB_PATH = join(process.cwd(), '..', 'data', 'platform.sqlite');
const DEFAULT_DOCUMENT_STORAGE_DIR = join(process.cwd(), '..', 'data', 'documents');
const DEFAULT_GENERATED_AGENTS_DIR = join(process.cwd(), '..', 'generated-agents');
const DEFAULT_PUBLIC_APP_URL = 'http://127.0.0.1:5173';
const DEFAULT_ABUSE_HASH_SECRET = 'primalthrum-development-abuse-hash-secret';

function sse(event: string, payload: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function normalizePassword(password: unknown): string {
  if (typeof password !== 'string' || password.length < 12) {
    throw new Error('password must be at least 12 characters');
  }
  return password;
}

function parseOptionalPositiveInteger(value: unknown): number | undefined | null {
  if (typeof value === 'undefined') {
    return undefined;
  }

  const candidate = Array.isArray(value) ? value[0] : value;
  const parsed = Number(candidate);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeIdempotencyKey(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(normalized)) {
    throw new Error('Idempotency-Key has an invalid format');
  }
  return normalized;
}

function streamRequestHash(body: Record<string, unknown>): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalValue(body)))
    .digest('hex');
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalValue(entry)]),
  );
}

function lastEventId(ctx: Koa.Context): number {
  const value = ctx.get('last-event-id') || ctx.query.after;
  const candidate = Array.isArray(value) ? value[0] : value;
  const parsed = Number(candidate ?? 0);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function runStreamHeaders(run: RunRecord): Record<string, string> {
  return {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-Primalthrum-Run-Id': String(run.id),
    ...(run.conversationId
      ? { 'X-Primalthrum-Conversation-Id': String(run.conversationId) }
      : {}),
    ...(run.idempotencyKey
      ? { 'X-Primalthrum-Idempotency-Key': run.idempotencyKey }
      : {}),
  };
}

export function createApp(options: AppOptions = {}): Koa {
  const app = new Koa();
  const router = new Router();
  const operatorRouter = new Router();
  const backgroundSchedulersEnabled = options.startBackgroundSchedulers !== false;
  const outboxDispatchers = new OutboxDispatcherLifecycle(backgroundSchedulersEnabled);
  const agentBaseUrl = options.agentBaseUrl ?? DEFAULT_AGENT_BASE_URL;
  const logger = options.logger ?? new JsonConsoleLogger();
  const metrics = options.metrics ?? new MetricsRegistry();
  const traceExporter = options.traceExporter;
  const databasePath = options.dbPath ?? DEFAULT_DB_PATH;
  const injectedAsyncDatabase = options.identityDatabase ?? options.runtimeDatabase;
  const db = options.database
    ? initializeDatabase(options.database)
    : injectedAsyncDatabase
      ? new DisabledDatabase()
      : createSqliteDatabase(databasePath);
  const ownedIdentityDatabase = !options.database && !injectedAsyncDatabase
    ? new AsyncSqliteDatabase(databasePath)
    : undefined;
  const identityDatabase = options.identityDatabase
    ?? options.runtimeDatabase
    ?? ownedIdentityDatabase;
  const runtimeDatabase = options.runtimeDatabase ?? identityDatabase;
  if (ownedIdentityDatabase) {
    registerAppCleanup(app, () => ownedIdentityDatabase.close());
  }
  const abuseProtection = options.abuseProtection ?? new AbuseProtectionService(
    runtimeDatabase
      ? new AsyncAbuseProtectionRepository(
          runtimeDatabase,
          options.abuseHashSecret ?? DEFAULT_ABUSE_HASH_SECRET,
        )
      : new AbuseProtectionRepository(db, options.abuseHashSecret ?? DEFAULT_ABUSE_HASH_SECRET),
    options.botChallengeVerifier,
    options.trustedProxyHops ?? 0,
  );
  const generatedAgentsDir = options.generatedAgentsDir ?? DEFAULT_GENERATED_AGENTS_DIR;
  const agentRepository: AgentStore = runtimeDatabase
    ? new AsyncAgentRepository(runtimeDatabase, generatedAgentsDir)
    : new AgentRepository(db, generatedAgentsDir);
  const agentVersionRepository: AgentVersionStore = runtimeDatabase
    ? new AsyncAgentVersionRepository(runtimeDatabase)
    : new AgentVersionRepository(db);
  const runRepository: RunStore = runtimeDatabase
    ? new AsyncRunRepository(runtimeDatabase)
    : new RunRepository(db);
  const streamEventRepository: StreamEventStore = runtimeDatabase
    ? new AsyncStreamEventRepository(runtimeDatabase)
    : new StreamEventRepository(db);
  const documentRepository: DocumentStore = runtimeDatabase
    ? new AsyncDocumentRepository(runtimeDatabase)
    : new DocumentRepository(db);
  const documentIndexRepository: DocumentIndexStore = runtimeDatabase
    ? new AsyncDocumentIndexRepository(runtimeDatabase)
    : new DocumentIndexRepository(db);
  const documentUploadSecurityRepository: DocumentUploadSecurityStore = runtimeDatabase
    ? new AsyncDocumentUploadSecurityRepository(runtimeDatabase)
    : new DocumentUploadSecurityRepository(db);
  const documentMalwareScanner = options.documentMalwareScanner ?? createDocumentMalwareScanner();
  const documentUploadSecurity = new DocumentUploadSecurityService(
    documentMalwareScanner,
    documentUploadSecurityRepository,
  );
  const conversationRepository: ConversationStore = runtimeDatabase
    ? new AsyncConversationRepository(runtimeDatabase)
    : new ConversationRepository(db);
  const documentStorage = options.documentStorage ?? new LocalDocumentStorage(
    options.documentStorageDir ?? DEFAULT_DOCUMENT_STORAGE_DIR,
  );
  const readiness = () => checkServerReadiness({
    ...(runtimeDatabase ? { asyncDatabase: runtimeDatabase } : { db }),
    agentBaseUrl,
    documentMalwareScanner,
    documentStorage,
  });
  const syncUserRepository = new UserRepository(db);
  const syncWorkspaceRepository = new WorkspaceRepository(db);
  const syncSessionRepository = new SessionRepository(db);
  const userRepository: UserStore = identityDatabase
    ? new AsyncUserRepository(identityDatabase)
    : syncUserRepository;
  const workspaceRepository: WorkspaceStore = identityDatabase
    ? new AsyncWorkspaceRepository(identityDatabase)
    : syncWorkspaceRepository;
  const sessionRepository: SessionStore = identityDatabase
    ? new AsyncSessionRepository(identityDatabase)
    : syncSessionRepository;
  const workspaceOwnershipRepository: WorkspaceOwnershipStore = identityDatabase
    ? new AsyncWorkspaceOwnershipRepository(identityDatabase)
    : new WorkspaceOwnershipRepository(db, syncWorkspaceRepository);
  const operatorIdentity: OperatorIdentityStore = runtimeDatabase
    ? new AsyncOperatorIdentityRepository(runtimeDatabase)
    : new OperatorIdentityRepository(db);
  const operatorAudit: OperatorAuditStore = runtimeDatabase
    ? new AsyncOperatorAuditRepository(runtimeDatabase)
    : new OperatorAuditRepository(db);
  const operatorBillingReads: OperatorBillingReadStore = runtimeDatabase
    ? new AsyncOperatorBillingReadRepository(runtimeDatabase)
    : new OperatorBillingReadRepository(db);
  const operatorCustomerReads: OperatorCustomerReadStore = runtimeDatabase
    ? new AsyncOperatorCustomerReadRepository(runtimeDatabase)
    : new OperatorCustomerReadRepository(db);
  const operatorFeatureFlags: OperatorFeatureFlagStore = runtimeDatabase
    ? new AsyncOperatorFeatureFlagRepository(runtimeDatabase)
    : new OperatorFeatureFlagRepository(db);
  const operatorIncidents: OperatorIncidentStore = runtimeDatabase
    ? new AsyncOperatorIncidentRepository(runtimeDatabase)
    : new OperatorIncidentRepository(db);
  const workspaceLegalHolds: WorkspaceLegalHoldStore = runtimeDatabase
    ? new AsyncWorkspaceLegalHoldRepository(runtimeDatabase)
    : new WorkspaceLegalHoldRepository(db);
  const operatorReads: OperatorReadStore = runtimeDatabase
    ? new AsyncOperatorReadRepository(runtimeDatabase)
    : new OperatorReadRepository(db);
  const operatorRuntimeReads: OperatorRuntimeReadStore = runtimeDatabase
    ? new AsyncOperatorRuntimeReadRepository(runtimeDatabase)
    : new OperatorRuntimeReadRepository(db);
  const operatorSecurityReads: OperatorSecurityReadStore = runtimeDatabase
    ? new AsyncOperatorSecurityReadRepository(runtimeDatabase)
    : new OperatorSecurityReadRepository(db);
  const supportAccess: SupportAccessStore = runtimeDatabase
    ? new AsyncSupportAccessRepository(runtimeDatabase)
    : new SupportAccessRepository(db);
  const localSecretVault = new LocalSecretVault(db);
  const asyncIdentitySecretVault = identityDatabase
    ? new AsyncSecretVault(identityDatabase)
    : null;
  const mfaService = new MfaService(identityDatabase && asyncIdentitySecretVault
    ? new AsyncMfaRepository(identityDatabase, asyncIdentitySecretVault)
    : new MfaRepository(db, localSecretVault));
  const apiKeyRepository: ApiKeyStore = runtimeDatabase
    ? new AsyncApiKeyRepository(runtimeDatabase)
    : new ApiKeyRepository(db);
  const asyncProviderSecretVault = runtimeDatabase
    ? new AsyncSecretVault(runtimeDatabase)
    : null;
  const providerSecretVault: SecretStore = asyncProviderSecretVault ?? localSecretVault;
  const providerConfigRepository: ProviderConfigStore = runtimeDatabase && asyncProviderSecretVault
    ? new AsyncProviderConfigRepository(runtimeDatabase, asyncProviderSecretVault)
    : new ProviderConfigRepository(db);
  const runtimeProviderResolver = new RuntimeProviderResolver(
    providerConfigRepository,
    providerSecretVault,
  );
  const embeddingClient = new AgentEmbeddingClient(agentBaseUrl);
  const speechClient = new AgentSpeechClient(agentBaseUrl);
  const speechResolver = new RuntimeSpeechResolver(
    providerConfigRepository,
    providerSecretVault,
  );
  const capabilitySettingsRepository: CapabilitySettingsStore = identityDatabase
    ? new AsyncCapabilitySettingsRepository(identityDatabase)
    : new CapabilitySettingsRepository(db);
  const billingRepository: BillingStore = runtimeDatabase
    ? new AsyncBillingRepository(runtimeDatabase)
    : new BillingRepository(db);
  const paymentRepository: PaymentLifecycleStore = runtimeDatabase
    ? new AsyncPaymentLifecycleRepository(runtimeDatabase)
    : new PaymentLifecycleRepository(db);
  const paymentAdapter = options.paymentAdapter;
  const usageExportOutboxRepository: UsageExportOutboxStore = runtimeDatabase
    ? new AsyncUsageExportOutboxRepository(runtimeDatabase)
    : new UsageExportOutboxRepository(db);
  let usageExportDispatcher: UsageExportDispatcher | undefined;
  const usageRatingRepository: UsageRatingStore = runtimeDatabase
    ? new AsyncUsageRatingRepository(
        runtimeDatabase,
        undefined,
        outboxDispatchers.kickUsageExport,
      )
    : new UsageRatingRepository(db, undefined, outboxDispatchers.kickUsageExport);
  const runtimeCreditLedger: CreditLedgerStore = runtimeDatabase
    ? new AsyncCreditLedgerRepository(runtimeDatabase)
    : new CreditLedgerRepository(db, () => new Date());
  const paymentWebhookProcessor = new PaymentWebhookProcessor(
    paymentRepository,
    billingRepository,
  );
  if (outboxDispatchers.enabled && options.usageMeterExporter) {
    usageExportDispatcher = new UsageExportDispatcher(
      outboxDispatchers.guardUsageExportStore(usageExportOutboxRepository),
      options.usageMeterExporter,
      logger,
      undefined,
      options.workerTraceExporter,
    );
    outboxDispatchers.attachUsageExport(usageExportDispatcher);
  }
  const runUsageService = new RunUsageService(usageRatingRepository, runtimeCreditLedger);
  const meteredOperationService = new MeteredOperationService(
    usageRatingRepository,
    runtimeCreditLedger,
  );
  const publicAppUrl = (options.publicAppUrl ?? DEFAULT_PUBLIC_APP_URL).replace(/\/$/, '');
  let accountEmailDispatcher: AccountEmailDispatcher | undefined;
  const accountEmailOutbox: AccountEmailOutboxStore = identityDatabase
    ? new AsyncAccountEmailOutboxRepository(
        identityDatabase,
        undefined,
        outboxDispatchers.kickAccountEmail,
      )
    : new AccountEmailOutboxRepository(
        db,
        undefined,
        outboxDispatchers.kickAccountEmail,
      );
  const accountIdentityService = new AccountIdentityService(
    userRepository,
    identityDatabase
      ? new AsyncAccountTokenRepository(identityDatabase)
      : new AccountTokenRepository(db),
    accountEmailOutbox,
    identityDatabase
      ? new AsyncAccountOnboardingRepository(identityDatabase)
      : new AccountOnboardingRepository(db),
    billingRepository,
    publicAppUrl,
  );
  const privacyAnalyticsRepository: PrivacyAnalyticsStore = runtimeDatabase
    ? new AsyncPrivacyAnalyticsRepository(runtimeDatabase)
    : new PrivacyAnalyticsRepository(db);
  const syncAccountPrivacyRepository = new AccountPrivacyRepository(db, options.accountPrivacyNow);
  const accountPrivacyRepository: AccountPrivacyStore = runtimeDatabase
    ? new AsyncAccountPrivacyRepository(runtimeDatabase, options.accountPrivacyNow)
    : syncAccountPrivacyRepository;
  const accountDataExports: AccountDataExportStore = runtimeDatabase
    ? new AsyncAccountDataExportService(
        runtimeDatabase,
        documentStorage,
        accountPrivacyRepository,
        options.accountPrivacyNow,
      )
    : new AccountDataExportService(
        db,
        documentStorage,
        syncAccountPrivacyRepository,
        options.accountPrivacyNow,
      );
  const accountDeletionService: AccountDeletionStore = runtimeDatabase
    ? new AsyncAccountDeletionService(
        runtimeDatabase,
        accountPrivacyRepository,
        documentStorage,
        options.accountPrivacyNow,
        options.accountDeletionGracePeriodMs,
      )
    : new AccountDeletionService(
        db,
        syncAccountPrivacyRepository,
        documentStorage,
        options.accountPrivacyNow,
        options.accountDeletionGracePeriodMs,
      );
  const retentionPolicies: RetentionPolicyStore = runtimeDatabase
    ? new AsyncRetentionPolicyRepository(runtimeDatabase)
    : new RetentionPolicyRepository(db);
  const retentionService = new RetentionService(retentionPolicies, documentStorage);
  if (outboxDispatchers.enabled && options.accountEmailSender) {
    accountEmailDispatcher = new AccountEmailDispatcher(
      outboxDispatchers.guardAccountEmailStore(accountEmailOutbox),
      options.accountEmailSender,
      logger,
      undefined,
      options.workerTraceExporter,
    );
    outboxDispatchers.attachAccountEmail(accountEmailDispatcher);
  }
  const paymentReady = Promise.all(
    Object.entries(options.paymentPriceRefs ?? {})
      .filter(([, priceRef]) => Boolean(priceRef.trim()))
      .map(([planKey, priceRef]) => Promise.resolve(
        paymentRepository.configurePrice('stripe', planKey, priceRef.trim()),
      )),
  ).then(() => undefined);
  void paymentReady.catch((error) => {
    logger.log({
      level: 'error',
      code: 'PAYMENT_PRICE_CONFIGURATION_FAILED',
      message: error instanceof Error ? error.message : 'payment price configuration failed',
    });
  });
  const toolAuditRepository: ToolAuditStore = runtimeDatabase
    ? new AsyncToolAuditRepository(runtimeDatabase)
    : new ToolAuditRepository(db);
  const jobRepository: JobStore = runtimeDatabase
    ? new AsyncJobRepository(runtimeDatabase, { leaseDurationMs: options.jobLeaseDurationMs })
    : new JobRepository(db, { leaseDurationMs: options.jobLeaseDurationMs });
  const jobDispatcher = new DurableJobDispatcher(jobRepository, {
    'document.index': async (payload) => {
      const agentId = Number(payload.agentId);
      const documentId = Number(payload.documentId);
      const agent = await agentRepository.findById(agentId);
      if (!agent) throw new Error('agent not found');
      const existing = await documentRepository.findByAgentDocument(agentId, documentId);
      if (!existing) throw new Error('document not found');
      let embeddingOperation: MeteredOperation | null = null;
      let embeddingCompleted = false;
      let ragStorageOperation: MeteredOperation | null = null;
      let ragStorageCompleted = false;
      try {
        const content = existing.storageRef
          ? await documentStorage.read(existing.storageRef)
          : '';
        const chunks = chunkDocumentText(existing.id, content);
        const ragEnabled = !['none', 'null'].includes(agent.config.ragProvider);
        const resolvedEmbedding = ragEnabled
          ? (await runtimeProviderResolver.resolve(agent.config, agent.workspaceId)).embedding
          : null;
        const estimatedEmbeddingTokens = Math.max(
          1,
          chunks.reduce((sum, chunk) => sum + Math.ceil(chunk.text.length / 4), 0),
        );
        if (resolvedEmbedding) {
          embeddingOperation = await meteredOperationService.begin({
            workspaceId: agent.workspaceId,
            idempotencyKey: `document:${documentId}:embedding:${existing.hash}`,
            meter: 'embedding.tokens',
            quantity: estimatedEmbeddingTokens,
            provider: resolvedEmbedding.provider,
            model: resolvedEmbedding.model,
            resourceType: 'document.embedding',
          });
        }
        const embeddingBatch = resolvedEmbedding
          ? await embeddingClient.embed(resolvedEmbedding, chunks.map((chunk) => chunk.text))
          : null;
        if (embeddingOperation && embeddingBatch) {
          await meteredOperationService.complete(
            embeddingOperation,
            { agentId, documentId, chunkCount: chunks.length },
            embeddingBatch.inputTokens ?? estimatedEmbeddingTokens,
          );
          embeddingCompleted = true;
        }
        if (ragEnabled) {
          ragStorageOperation = await meteredOperationService.begin({
            workspaceId: agent.workspaceId,
            idempotencyKey: `document:${documentId}:rag-storage:${existing.hash}`,
            meter: 'rag.storage_bytes',
            quantity: existing.sizeBytes,
            resourceType: 'document.rag-storage',
          });
        }
        const entries = await documentIndexRepository.reindex(existing, chunks, {
          embeddings: embeddingBatch?.embeddings ?? [],
          embeddingProvider: embeddingBatch?.provider ?? '',
          embeddingModel: embeddingBatch?.model ?? '',
          vectorStore: ragEnabled ? agent.config.ragProvider : '',
        });
        if (ragStorageOperation) {
          await meteredOperationService.complete(ragStorageOperation, {
            agentId,
            documentId,
            vectorStore: agent.config.ragProvider,
            indexEntryCount: entries.length,
          });
          ragStorageCompleted = true;
        }
        const document = await documentRepository.markIndexed(agentId, documentId);
        if (!document) throw new Error('document not found');
        return {
          document,
          indexEntryCount: entries.length,
          embeddingDimensions: embeddingBatch?.dimensions ?? 0,
          vectorStore: ragEnabled ? agent.config.ragProvider : 'none',
        };
      } catch (error) {
        if (embeddingOperation && !embeddingCompleted) {
          await releaseMeteredOperation(embeddingOperation);
        }
        if (ragStorageOperation && !ragStorageCompleted) {
          await releaseMeteredOperation(ragStorageOperation);
        }
        await documentRepository.markStatus(agentId, documentId, 'failed');
        throw error;
      }
    },
    'retention.enforce': async (payload) => {
      const workspaceId = Number(payload.workspaceId);
      if (!Number.isSafeInteger(workspaceId) || workspaceId <= 0) {
        throw new Error('retention job workspaceId is invalid');
      }
      return await retentionService.enforce(workspaceId, null) as unknown as Record<string, unknown>;
    },
    'account.delete': (payload) => {
      const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
      if (!requestId) throw new Error('account deletion job requestId is invalid');
      return accountDeletionService.execute(requestId);
    },
  }, (error) => {
    logger.log({
      level: 'error',
      code: 'JOB_DISPATCH_FAILED',
      message: error instanceof Error ? error.message : 'job dispatcher failed',
    });
  }, Math.max(250, Math.floor(
    (options.jobLeaseDurationMs ?? DEFAULT_JOB_LEASE_DURATION_MS) / 3,
  )), options.workerTraceExporter);
  const kickJobDispatcher = backgroundSchedulersEnabled
    ? () => jobDispatcher.kick()
    : () => undefined;
  const retentionScheduler = new RetentionScheduler(
    retentionPolicies,
    jobRepository,
    kickJobDispatcher,
    undefined,
    (error) => logger.log({
      level: 'error',
      code: 'RETENTION_SCHEDULER_FAILED',
      message: error instanceof Error ? error.message : 'retention scheduler failed',
    }),
  );
  const accountPrivacyScheduler = new AccountPrivacyScheduler(
    accountPrivacyRepository,
    jobRepository,
    kickJobDispatcher,
    options.accountPrivacySchedulerIntervalMs,
    (error) => logger.log({
      level: 'error',
      code: 'ACCOUNT_PRIVACY_SCHEDULER_FAILED',
      message: error instanceof Error ? error.message : 'account privacy scheduler failed',
    }),
  );
  if (traceExporter) registerAppCleanup(app, () => traceExporter.shutdown());
  if (backgroundSchedulersEnabled) {
    jobDispatcher.start(
      options.jobPollIntervalMs,
      options.backgroundTimersUnref ?? true,
    );
    retentionScheduler.start();
    accountPrivacyScheduler.start();
    outboxDispatchers.start(
      options.jobPollIntervalMs,
      options.backgroundTimersUnref ?? true,
    );
    registerAppCleanup(app, async () => {
      accountPrivacyScheduler.stop();
      retentionScheduler.stop();
      await Promise.all([
        jobDispatcher.stop(),
        outboxDispatchers.stop(),
      ]);
    });
  }

  function authorize(ctx: Koa.Context, permission: WorkspacePermission): boolean {
    if (ctx.state.apiKey) {
      const requiredScope = apiKeyScopeForPermission(permission);
      if (requiredScope && ctx.state.apiKey.scopes.includes(requiredScope)) return true;
      sendApiError(ctx, logger, {
        status: 403,
        code: 'API_KEY_SCOPE_FORBIDDEN',
        message: `API key scope ${requiredScope ?? 'unavailable'} is required`,
      });
      return false;
    }
    const role = ctx.state.authSession?.user.role;
    if (typeof role === 'string' && hasWorkspacePermission(role, permission)) {
      return true;
    }
    sendApiError(ctx, logger, {
      status: 403,
      code: 'AUTHORIZATION_FORBIDDEN',
      message: `permission ${permission} is required`,
    });
    return false;
  }

  function currentWorkspaceId(ctx: Koa.Context): number {
    return Number(ctx.state.authSession?.user.workspaceId);
  }

  function currentUserId(ctx: Koa.Context): number {
    return Number(ctx.state.authSession?.user.id);
  }

  async function releaseMeteredOperation(operation: MeteredOperation): Promise<void> {
    try {
      await meteredOperationService.release(operation);
    } catch (error) {
      logger.log({
        level: 'warn',
        code: 'METERED_OPERATION_RELEASE_SKIPPED',
        message: error instanceof Error ? error.message : 'metered operation release failed',
        context: { resourceType: operation.resourceType, resourceId: operation.resourceId },
      });
    }
  }

  async function storeMeteredDocument(
    ctx: Koa.Context,
    agentId: number,
    upload: ParsedDocumentUpload,
  ) {
    const operation = await meteredOperationService.begin({
      workspaceId: currentWorkspaceId(ctx),
      idempotencyKey: normalizeIdempotencyKey(
        ctx.get('idempotency-key') || randomUUID(),
      ),
      meter: 'file.storage_bytes',
      quantity: upload.sizeBytes,
      resourceType: 'document.storage',
    });
    let document: DocumentRecord | null = null;
    let storageRef = '';
    try {
      document = await documentRepository.create(agentId, upload);
      const stored = await documentStorage.save({
        workspaceId: document.workspaceId,
        agentId: document.agentId,
        documentId: document.id,
        filename: document.filename,
        content: upload.content,
      });
      storageRef = stored.storageRef;
      const result = await documentRepository.attachStorageRef(agentId, document.id, storageRef)
        ?? document;
      await meteredOperationService.complete(operation, { documentId: document.id });
      return result;
    } catch (error) {
      if (storageRef) {
        try {
          await documentStorage.delete(storageRef);
        } catch (cleanupError) {
          logger.log({
            level: 'error',
            code: 'DOCUMENT_STORAGE_CLEANUP_FAILED',
            message: cleanupError instanceof Error
              ? cleanupError.message
              : 'document storage cleanup failed',
            context: { agentId },
          });
        }
      }
      if (document) await documentRepository.deleteByAgentDocument(agentId, document.id);
      await releaseMeteredOperation(operation);
      throw error;
    }
  }

  async function inspectDocumentUpload(
    ctx: Koa.Context,
    agentId: number,
    upload: ParsedDocumentUpload,
  ): Promise<void> {
    await documentUploadSecurity.inspect({
      workspaceId: currentWorkspaceId(ctx),
      agentId,
      userId: currentUserId(ctx),
      upload,
    });
  }

  function sendDocumentUploadError(ctx: Koa.Context, error: unknown): void {
    if (error instanceof DocumentThreatDetectedError) {
      sendApiError(ctx, logger, {
        status: 422,
        code: 'DOCUMENT_THREAT_DETECTED',
        message: 'document failed malware scan',
      });
      return;
    }
    if (error instanceof DocumentScanUnavailableError) {
      sendApiError(ctx, logger, {
        status: 503,
        code: 'DOCUMENT_SCAN_UNAVAILABLE',
        message: 'document malware scanner is unavailable',
      });
      return;
    }
    const quotaFailure = error instanceof BillingError || error instanceof UsageRatingError;
    sendApiError(ctx, logger, {
      status: quotaFailure ? 402 : 400,
      code: quotaFailure ? 'CREDIT_LIMIT_EXCEEDED' : 'DOCUMENT_INVALID',
      message: error instanceof Error ? error.message : 'failed to upload document',
    });
  }

  async function scopedAgent(
    ctx: Koa.Context,
    id: number,
    permission: WorkspacePermission,
  ) {
    if (!authorize(ctx, permission)) return null;
    const agent = await agentRepository.findByIdInWorkspace(id, currentWorkspaceId(ctx));
    if (!agent) {
      sendApiError(ctx, logger, {
        status: 404,
        code: 'AGENT_NOT_FOUND',
        message: 'agent not found',
      });
      return null;
    }
    return agent;
  }

  function requireCurrentWorkspace(ctx: Koa.Context, workspaceId: number): boolean {
    if (workspaceId === currentWorkspaceId(ctx)) return true;
    sendApiError(ctx, logger, {
      status: 404,
      code: 'WORKSPACE_NOT_FOUND',
      message: 'workspace not found',
    });
    return false;
  }

  registerBillingRoutes(router, {
    authorize,
    billing: billingRepository,
    currentUserId,
    currentWorkspaceId,
    logger,
    paymentAdapter,
    payments: paymentRepository,
    paymentsReady: paymentReady,
    publicAppUrl,
    stripeWebhookSecret: options.stripeWebhookSecret,
    usage: usageRatingRepository,
    webhooks: paymentWebhookProcessor,
  });
  registerSpeechRoutes(router, {
    authorize,
    capabilities: capabilitySettingsRepository,
    currentWorkspaceId,
    logger,
    metering: meteredOperationService,
    resolver: speechResolver,
    speech: speechClient,
  });
  registerPrivacyRoutes(router, {
    analytics: privacyAnalyticsRepository,
    currentUserId,
    currentWorkspaceId,
    deletion: accountDeletionService,
    exports: accountDataExports,
    logger,
    users: userRepository,
  });
  registerAccountEmailRoutes(router, {
    outbox: accountEmailOutbox,
    verifier: options.accountEmailWebhookVerifier,
    logger,
    metrics,
  });
  registerAbuseRoutes(router, { turnstileSiteKey: options.botChallengeSiteKey });
  registerSecuritySettingsRoutes(router, {
    apiKeys: apiKeyRepository,
    authorize,
    currentUserId,
    currentWorkspaceId,
    logger,
    sessions: sessionRepository,
    users: userRepository,
  });
  registerRetentionSettingsRoutes(router, {
    authorize,
    billing: billingRepository,
    currentUserId,
    currentWorkspaceId,
    logger,
    policies: retentionPolicies,
    retention: retentionService,
    schedule: (workspaceId) => retentionScheduler.trigger(workspaceId),
    users: userRepository,
  });
  registerWorkspaceOwnershipRoutes(router, {
    authorize,
    currentUserId,
    logger,
    ownership: workspaceOwnershipRepository,
    requireCurrentWorkspace,
    users: userRepository,
  });
  registerMfaRoutes(router, {
    currentUserId,
    logger,
    mfa: mfaService,
    sessions: sessionRepository,
    users: userRepository,
    completeChallenge: async (verified) => {
      const user = await userRepository.findById(verified.userId);
      if (!user) throw new Error('MFA user could not be loaded');
      if (verified.purpose === 'invitation') {
        const workspaceId = Number(verified.context.workspaceId);
        const invitationId = Number(verified.context.invitationId);
        if (!Number.isSafeInteger(workspaceId) || !Number.isSafeInteger(invitationId)) {
          throw new Error('invitation challenge context is invalid');
        }
        await billingRepository.assertEntitled(
          workspaceId,
          'seats',
          (await workspaceRepository.listMembers(workspaceId)).length,
          1,
        );
        await workspaceRepository.acceptInvitationById(
          workspaceId,
          invitationId,
          user.id,
          user.email,
        );
        await accountEmailOutbox.supersedeInvitation(invitationId);
        const invitedPrincipal = await workspaceRepository.principalForUser(user.id, workspaceId);
        if (!invitedPrincipal) throw new Error('workspace membership could not be loaded');
        return {
          user: invitedPrincipal,
          emailVerified: Boolean(user.emailVerifiedAt),
          status: 201,
        };
      }
      const principal = await workspaceRepository.principalForUser(user.id);
      if (!principal) throw new Error('workspace membership is required');
      return { user: principal, emailVerified: Boolean(user.emailVerifiedAt) };
    },
  });
  registerOperatorRoutes(operatorRouter, {
    audit: operatorAudit,
    bootstrapToken: options.operatorBootstrapToken,
    enforceAbuse: (ctx) => abuseProtection.enforce(ctx, logger, metrics),
    identity: operatorIdentity,
    logger,
    reads: operatorReads,
    readiness,
    support: supportAccess,
  });
  registerOperatorDomainRoutes(operatorRouter, {
    audit: operatorAudit,
    billingReads: operatorBillingReads,
    customerReads: operatorCustomerReads,
    identity: operatorIdentity,
    logger,
    runtimeReads: operatorRuntimeReads,
    securityReads: operatorSecurityReads,
  });
  registerOperatorChangeRoutes(operatorRouter, {
    audit: operatorAudit,
    featureFlags: operatorFeatureFlags,
    identity: operatorIdentity,
    incidents: operatorIncidents,
    logger,
  });
  registerOperatorLegalHoldRoutes(operatorRouter, {
    audit: operatorAudit,
    identity: operatorIdentity,
    legalHolds: workspaceLegalHolds,
    logger,
  });

  if (traceExporter) app.use(createHttpTracingMiddleware(traceExporter));
  app.use(async (ctx, next) => {
    const origin = ctx.get('origin');
    ctx.set('Access-Control-Allow-Origin', origin || '*');
    ctx.set('Access-Control-Allow-Credentials', 'true');
    ctx.set(
      'Access-Control-Allow-Headers',
      'Content-Type, Accept, Authorization, Idempotency-Key, Last-Event-ID, Traceparent, X-Bot-Challenge-Token, X-Operator-Bootstrap-Token',
    );
    ctx.set(
      'Access-Control-Expose-Headers',
      'Traceparent, X-Request-ID, X-Primalthrum-Run-Id, X-Primalthrum-Conversation-Id, X-Primalthrum-Idempotency-Key, Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset',
    );
    ctx.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    ctx.set('Vary', 'Origin');

    if (ctx.method === 'OPTIONS') {
      ctx.status = 204;
      return;
    }

    await next();
  });
  app.use(bodyParser({ jsonLimit: '12mb' }));
  app.use(async (ctx, next) => {
    const startedAt = Date.now();
    try {
      await next();
    } finally {
      metrics.observeHttpRequest({
        method: ctx.method,
        path: ctx.path,
        status: ctx.status,
        durationMs: Date.now() - startedAt,
      });
    }
  });
  app.use(operatorRouter.routes());
  app.use(operatorRouter.allowedMethods());
  app.use(createAuthMiddleware(sessionRepository, apiKeyRepository));
  app.use(async (ctx, next) => {
    if (await abuseProtection.enforce(ctx, logger, metrics)) await next();
  });

  router.get('/health', (ctx) => {
    ctx.body = {
      status: 'ok',
      service: 'server',
      agentBaseUrl,
    };
  });

  router.get('/ready', async (ctx) => {
    const report = await readiness();
    ctx.status = report.status === 'ready' ? 200 : 503;
    ctx.body = report;
  });

  router.get('/metrics', async (ctx) => {
    ctx.type = 'text/plain; version=0.0.4';
    ctx.body = metrics.toPrometheusText(await accountEmailOutbox.summary());
  });

  router.get('/api/setup/status', async (ctx) => {
    ctx.body = {
      needsSetup: !await userRepository.hasAdmin(),
    };
  });

  router.post('/api/setup/admin', async (ctx) => {
    try {
      if (await userRepository.hasAdmin()) {
        ctx.status = 409;
        ctx.body = { error: 'admin user already exists' };
        return;
      }

      const body = ctx.request.body as { email?: unknown; password?: unknown };
      const email = normalizeEmail(body.email);
      const password = normalizePassword(body.password);
      const createdUser = await userRepository.createAdmin(email, hashPassword(password));
      const user = await workspaceRepository.principalForUser(createdUser.id);
      if (!user) throw new Error('admin workspace membership could not be loaded');
      const session = await sessionRepository.create(user);

      ctx.set('Set-Cookie', sessionCookie(session.token, session.expiresAt));
      ctx.status = 201;
      ctx.body = { user, session, emailVerified: true };
    } catch (error) {
      ctx.status = 400;
      ctx.body = {
        error: error instanceof Error ? error.message : 'failed to create admin',
      };
    }
  });

  router.post('/api/auth/login', async (ctx) => {
    try {
      const body = ctx.request.body as { email?: unknown; password?: unknown };
      const email = normalizeEmail(body.email);
      const password = normalizePassword(body.password);
      const user = await userRepository.findByEmail(email);
      const passwordMatches = verifyPasswordOrDummy(password, user?.passwordHash ?? null);

      if (!user || !passwordMatches) {
        ctx.status = 401;
        ctx.body = { error: 'invalid email or password' };
        return;
      }

      const publicUser = await workspaceRepository.principalForUser(user.id);
      if (!publicUser) {
        ctx.status = 403;
        ctx.body = { error: 'workspace membership is required' };
        return;
      }
      if (await mfaService.isEnabled(user.id)) {
        ctx.status = 202;
        ctx.body = await mfaService.createChallenge(user.id, 'login');
        return;
      }
      const session = await sessionRepository.create(publicUser);
      ctx.set('Set-Cookie', sessionCookie(session.token, session.expiresAt));
      ctx.body = { user: publicUser, session, emailVerified: Boolean(user.emailVerifiedAt) };
    } catch (error) {
      ctx.status = 400;
      ctx.body = {
        error: error instanceof Error ? error.message : 'failed to login',
      };
    }
  });

  router.post('/api/auth/register', async (ctx) => {
    try {
      const body = ctx.request.body as {
        email?: unknown;
        password?: unknown;
        workspaceName?: unknown;
        planKey?: unknown;
      };
      const email = normalizeEmail(body.email);
      const password = normalizePassword(body.password);
      const workspaceName = typeof body.workspaceName === 'string'
        ? body.workspaceName.trim()
        : '';
      const planKey = typeof body.planKey === 'string' ? body.planKey.trim() : 'pro';
      if (!workspaceName) throw new Error('workspace name is required');
      if (!['free', 'pro'].includes(planKey)) {
        throw new Error('registration plan must be free or pro');
      }
      if (await userRepository.findByEmail(email)) {
        sendApiError(ctx, logger, {
          status: 409,
          code: 'ACCOUNT_ALREADY_EXISTS',
          message: 'an account with this email already exists',
        });
        return;
      }

      const createdUser = await userRepository.createUser(email, hashPassword(password));
      const workspace = await workspaceRepository.create(createdUser.id, workspaceName);
      const user = await workspaceRepository.principalForUser(createdUser.id, workspace.id);
      if (!user) throw new Error('workspace owner membership could not be loaded');
      const session = await sessionRepository.create(user);
      const emailPreviewUrl = await accountIdentityService.beginRegistration({
        userId: user.id,
        workspaceId: workspace.id,
        email: user.email,
        planKey: planKey as 'free' | 'pro',
      });

      ctx.set('Set-Cookie', sessionCookie(session.token, session.expiresAt));
      ctx.status = 201;
      ctx.body = {
        user,
        session,
        workspace,
        verificationRequired: true,
        emailVerified: false,
        ...(options.exposeAccountEmailPreview ? { emailPreviewUrl } : {}),
        entitlementSnapshot: await billingRepository.entitlementSnapshot(workspace.id),
        creditAccount: await billingRepository.creditAccount(workspace.id),
      };
    } catch (error) {
      if (isDuplicateEmailError(error)) {
        sendApiError(ctx, logger, {
          status: 409,
          code: 'ACCOUNT_ALREADY_EXISTS',
          message: 'an account with this email already exists',
        });
        return;
      }
      sendApiError(ctx, logger, {
        status: error instanceof BillingError ? 409 : 400,
        code: 'REGISTRATION_INVALID',
        message: error instanceof Error ? error.message : 'registration failed',
      });
    }
  });

  router.post('/api/auth/verify-email', async (ctx) => {
    try {
      const token = String((ctx.request.body as { token?: unknown }).token ?? '');
      ctx.body = { verified: true, ...await accountIdentityService.verifyEmail(token) };
    } catch (error) {
      sendApiError(ctx, logger, {
        status: 400,
        code: 'EMAIL_VERIFICATION_INVALID',
        message: error instanceof Error ? error.message : 'email verification failed',
      });
    }
  });

  router.post('/api/auth/verification/resend', async (ctx) => {
    const token = extractSessionToken(ctx);
    const session = token ? await sessionRepository.findByToken(token) : null;
    if (!session) {
      sendApiError(ctx, logger, { status: 401, code: 'AUTHENTICATION_REQUIRED',
        message: 'authentication required' });
      return;
    }
    const emailPreviewUrl = await accountIdentityService.resendVerification(session.user.id);
    ctx.status = 202;
    ctx.body = {
      accepted: true,
      ...(options.exposeAccountEmailPreview && emailPreviewUrl ? { emailPreviewUrl } : {}),
    };
  });

  router.post('/api/auth/password/forgot', async (ctx) => {
    try {
      const email = normalizeEmail((ctx.request.body as { email?: unknown }).email);
      const emailPreviewUrl = await accountIdentityService.requestPasswordReset(email);
      ctx.status = 202;
      ctx.body = {
        accepted: true,
        ...(options.exposeAccountEmailPreview && emailPreviewUrl ? { emailPreviewUrl } : {}),
      };
    } catch {
      ctx.status = 202;
      ctx.body = { accepted: true };
    }
  });

  router.post('/api/auth/password/reset', async (ctx) => {
    try {
      const body = ctx.request.body as { token?: unknown; password?: unknown };
      const password = normalizePassword(body.password);
      const userId = await accountIdentityService.consumePasswordReset(String(body.token ?? ''));
      await userRepository.updatePassword(userId, hashPassword(password));
      await sessionRepository.revokeAllForUser(userId);
      ctx.body = { reset: true };
    } catch (error) {
      sendApiError(ctx, logger, { status: 400, code: 'PASSWORD_RESET_INVALID',
        message: error instanceof Error ? error.message : 'password reset failed' });
    }
  });

  router.post('/api/auth/logout', async (ctx) => {
    const token = extractSessionToken(ctx);
    if (token) {
      await sessionRepository.revokeToken(token);
    }

    ctx.set('Set-Cookie', clearSessionCookie());
    ctx.status = 204;
  });

  router.get('/api/auth/session', async (ctx) => {
    const token = extractSessionToken(ctx);
    const session = token ? await sessionRepository.findByToken(token) : null;
    if (!session) {
      ctx.status = 401;
      ctx.body = { error: 'authentication required' };
      return;
    }

    ctx.body = session;
  });

  router.post('/api/auth/workspace', async (ctx) => {
    const body = ctx.request.body as { workspaceId?: unknown };
    const workspaceId = Number(body.workspaceId);
    const authSession = ctx.state.authSession;
    const token = ctx.state.sessionToken;
    if (!authSession || !token || !Number.isInteger(workspaceId) || workspaceId <= 0) {
      sendApiError(ctx, logger, {
        status: 400,
        code: 'WORKSPACE_INVALID',
        message: 'workspaceId must be a positive integer',
      });
      return;
    }
    try {
      await sessionRepository.switchWorkspace(token, authSession.user.id, workspaceId);
      const selected = await sessionRepository.findByToken(token);
      if (!selected) throw new Error('workspace session could not be loaded');
      ctx.body = selected;
    } catch (error) {
      sendApiError(ctx, logger, {
        status: 403,
        code: 'AUTHORIZATION_FORBIDDEN',
        message: error instanceof Error ? error.message : 'workspace membership is required',
      });
    }
  });

  router.get('/api/workspaces', async (ctx) => {
    if (!authorize(ctx, 'workspace.read')) return;
    ctx.body = await workspaceRepository.listForUser(ctx.state.authSession.user.id);
  });

  router.post('/api/workspaces', async (ctx) => {
    const authSession = ctx.state.authSession;
    const token = ctx.state.sessionToken;
    if (!authSession || !token) return;
    try {
      const body = ctx.request.body as { name?: unknown };
      const workspace = await workspaceRepository.create(authSession.user.id, body.name);
      await sessionRepository.switchWorkspace(token, authSession.user.id, workspace.id);
      ctx.status = 201;
      ctx.body = {
        workspace,
        session: await sessionRepository.findByToken(token),
      };
    } catch (error) {
      sendApiError(ctx, logger, {
        status: 400,
        code: 'WORKSPACE_INVALID',
        message: error instanceof Error ? error.message : 'failed to create workspace',
      });
    }
  });

  router.get('/api/workspaces/:id/members', async (ctx) => {
    const workspaceId = Number(ctx.params.id);
    if (!requireCurrentWorkspace(ctx, workspaceId) || !authorize(ctx, 'workspace.read')) return;
    ctx.body = await workspaceRepository.listMembers(workspaceId);
  });

  router.patch('/api/workspaces/:id/members/:userId', async (ctx) => {
    const workspaceId = Number(ctx.params.id);
    if (!requireCurrentWorkspace(ctx, workspaceId) || !authorize(ctx, 'members.manage')) return;
    try {
      const userId = Number(ctx.params.userId);
      if (userId === ctx.state.authSession.user.id) {
        throw new Error('you cannot change your own workspace role');
      }
      const body = ctx.request.body as { role?: unknown };
      ctx.body = await workspaceRepository.updateMemberRole(
        workspaceId,
        userId,
        body.role,
      );
    } catch (error) {
      sendApiError(ctx, logger, {
        status: 400,
        code: 'WORKSPACE_MEMBER_INVALID',
        message: error instanceof Error ? error.message : 'failed to update member',
      });
    }
  });

  router.delete('/api/workspaces/:id/members/:userId', async (ctx) => {
    const workspaceId = Number(ctx.params.id);
    if (!requireCurrentWorkspace(ctx, workspaceId) || !authorize(ctx, 'members.manage')) return;
    try {
      const userId = Number(ctx.params.userId);
      if (userId === ctx.state.authSession.user.id) {
        throw new Error('you cannot remove yourself from the current workspace');
      }
      await workspaceRepository.removeMember(workspaceId, userId);
      ctx.status = 204;
    } catch (error) {
      sendApiError(ctx, logger, {
        status: 400,
        code: 'WORKSPACE_MEMBER_INVALID',
        message: error instanceof Error ? error.message : 'failed to remove member',
      });
    }
  });

  router.get('/api/workspaces/:id/invitations', async (ctx) => {
    const workspaceId = Number(ctx.params.id);
    if (!requireCurrentWorkspace(ctx, workspaceId) || !authorize(ctx, 'members.manage')) return;
    ctx.body = await workspaceRepository.listInvitations(workspaceId);
  });

  router.post('/api/workspaces/:id/invitations', async (ctx) => {
    const workspaceId = Number(ctx.params.id);
    if (!requireCurrentWorkspace(ctx, workspaceId) || !authorize(ctx, 'members.manage')) return;
    try {
      const body = ctx.request.body as { email?: unknown; role?: unknown };
      const email = await workspaceRepository.validateInvitationTarget(workspaceId, body.email);
      const memberCount = (await workspaceRepository.listMembers(workspaceId)).length;
      const pendingInvitationCount = await workspaceRepository.pendingInvitationCount(workspaceId, email);
      await billingRepository.assertEntitled(
        workspaceId,
        'seats',
        memberCount + pendingInvitationCount,
        1,
      );
      ctx.status = 201;
      const invitation = await workspaceRepository.createInvitation({
        workspaceId,
        email,
        role: body.role,
        invitedByUserId: ctx.state.authSession.user.id,
      });
      const workspace = await workspaceRepository.findById(workspaceId);
      if (!workspace) throw new Error('workspace not found');
      const acceptUrl = `${publicAppUrl}/accept-invitation?token=${encodeURIComponent(invitation.token)}`;
      try {
        await accountEmailOutbox.supersedePendingInvitations(workspaceId, email, invitation.id);
        await accountEmailOutbox.enqueue({
          template: 'workspace_invitation',
          recipientEmail: email,
          payload: {
            workspaceId,
            invitationId: invitation.id,
            workspaceName: workspace.name,
            role: invitation.role,
            actionUrl: acceptUrl,
          },
        });
      } catch (error) {
        await workspaceRepository.revokeInvitation(workspaceId, invitation.id);
        throw error;
      }
      ctx.body = {
        ...invitation,
        acceptUrl,
        emailDelivery: 'queued',
      };
    } catch (error) {
      sendApiError(ctx, logger, {
        status: teamEntitlementErrorCode(error) ? 403 : 400,
        code: teamEntitlementErrorCode(error) ?? 'WORKSPACE_INVITATION_INVALID',
        message: error instanceof Error ? error.message : 'failed to create invitation',
      });
    }
  });

  router.delete('/api/workspaces/:id/invitations/:invitationId', async (ctx) => {
    const workspaceId = Number(ctx.params.id);
    if (!requireCurrentWorkspace(ctx, workspaceId) || !authorize(ctx, 'members.manage')) return;
    try {
      const invitationId = Number(ctx.params.invitationId);
      await workspaceRepository.revokeInvitation(workspaceId, invitationId);
      await accountEmailOutbox.supersedeInvitation(invitationId);
      ctx.status = 204;
    } catch (error) {
      sendApiError(ctx, logger, {
        status: 400,
        code: 'WORKSPACE_INVITATION_INVALID',
        message: error instanceof Error ? error.message : 'failed to revoke invitation',
      });
    }
  });

  router.post('/api/invitations/accept', async (ctx) => {
    try {
      const body = ctx.request.body as { token?: unknown; password?: unknown };
      const token = typeof body.token === 'string' ? body.token : '';
      const invitation = await workspaceRepository.activeInvitationByToken(token);
      if (!invitation) throw new Error('invitation is invalid or expired');
      const password = normalizePassword(body.password);
      let user = await userRepository.findByEmail(invitation.email);
      if (user && !verifyPassword(password, user.passwordHash)) {
        ctx.status = 401;
        ctx.body = { error: 'invalid email or password' };
        return;
      }
      await billingRepository.assertEntitled(
        invitation.workspaceId,
        'seats',
        (await workspaceRepository.listMembers(invitation.workspaceId)).length,
        1,
      );
      if (user && await mfaService.isEnabled(user.id)) {
        ctx.status = 202;
        ctx.body = await mfaService.createChallenge(user.id, 'invitation', {
          invitationId: invitation.id,
          workspaceId: invitation.workspaceId,
        });
        return;
      }
      user ??= await userRepository.createUser(invitation.email, hashPassword(password), true);
      await workspaceRepository.acceptInvitation(token, user.id, user.email);
      await accountEmailOutbox.supersedeInvitation(invitation.id);
      const principal = await workspaceRepository.principalForUser(user.id, invitation.workspaceId);
      if (!principal) throw new Error('workspace membership could not be loaded');
      const session = await sessionRepository.create(principal);
      ctx.set('Set-Cookie', sessionCookie(session.token, session.expiresAt));
      ctx.status = 201;
      ctx.body = { user: principal, session, emailVerified: true };
    } catch (error) {
      sendApiError(ctx, logger, {
        status: teamEntitlementErrorCode(error) ? 403 : 400,
        code: teamEntitlementErrorCode(error) ?? 'WORKSPACE_INVITATION_INVALID',
        message: error instanceof Error ? error.message : 'failed to accept invitation',
      });
    }
  });

  router.get('/api/agents', async (ctx) => {
    if (!authorize(ctx, 'agents.read')) return;
    ctx.body = await agentRepository.list(currentWorkspaceId(ctx));
  });

  router.post('/api/agents', async (ctx) => {
    if (!authorize(ctx, 'agents.write')) return;
    try {
      const created = await agentRepository.create(
        ctx.request.body as CreateAgentInput,
        currentWorkspaceId(ctx),
      );
      ctx.status = 201;
      ctx.body = created;
    } catch (error) {
      ctx.status = 400;
      ctx.body = {
        error: error instanceof Error ? error.message : 'failed to create agent',
      };
    }
  });

  router.get('/api/agents/slug/:slug', async (ctx) => {
    const agent = await agentRepository.findBySlug(ctx.params.slug);
    if (!authorize(ctx, 'agents.read')) return;
    if (!agent || agent.workspaceId !== currentWorkspaceId(ctx)) {
      ctx.status = 404;
      ctx.body = { error: 'agent not found' };
      return;
    }
    ctx.body = agent;
  });

  router.get('/api/agents/:id', async (ctx) => {
    const agent = await scopedAgent(ctx, Number(ctx.params.id), 'agents.read');
    if (!agent) return;
    ctx.body = agent;
  });

  router.post('/api/agents/:id/generate', async (ctx) => {
    const agent = await scopedAgent(ctx, Number(ctx.params.id), 'agents.write');
    if (!agent) return;

    const generated = await generateAgentProject(agent);
    const generatedAgent = await agentRepository.markGenerated(agent.id);
    const preview = await agentVersionRepository.createPreview(
      generatedAgent,
      ctx.state.authSession.user.id,
    );
    await agentVersionRepository.publish(
      generatedAgent,
      preview.version.id,
      ctx.state.authSession.user.id,
    );
    ctx.body = generated;
  });

  router.get('/api/agents/:id/versions', async (ctx) => {
    const agent = await scopedAgent(ctx, Number(ctx.params.id), 'agents.read');
    if (!agent) return;
    ctx.body = await agentVersionRepository.listVersions(agent.id, agent.workspaceId);
  });

  router.post('/api/agents/:id/versions', async (ctx) => {
    const agent = await scopedAgent(ctx, Number(ctx.params.id), 'agents.write');
    if (!agent) return;
    try {
      ctx.status = 201;
      ctx.body = await agentVersionRepository.createPreview(
        agent,
        ctx.state.authSession.user.id,
      );
    } catch (error) {
      sendApiError(ctx, logger, {
        status: 400,
        code: 'AGENT_VERSION_INVALID',
        message: error instanceof Error ? error.message : 'failed to create agent version',
      });
    }
  });

  router.post('/api/agents/:id/versions/:versionId/publish', async (ctx) => {
    const agent = await scopedAgent(ctx, Number(ctx.params.id), 'agents.publish');
    if (!agent) return;
    try {
      ctx.body = await agentVersionRepository.publish(
        agent,
        Number(ctx.params.versionId),
        ctx.state.authSession.user.id,
      );
    } catch (error) {
      sendApiError(ctx, logger, {
        status: 400,
        code: 'AGENT_VERSION_INVALID',
        message: error instanceof Error ? error.message : 'failed to publish agent version',
      });
    }
  });

  router.post('/api/agents/:id/versions/:versionId/rollback', async (ctx) => {
    const agent = await scopedAgent(ctx, Number(ctx.params.id), 'agents.publish');
    if (!agent) return;
    try {
      ctx.body = await agentVersionRepository.publish(
        agent,
        Number(ctx.params.versionId),
        ctx.state.authSession.user.id,
        'rollback',
      );
    } catch (error) {
      sendApiError(ctx, logger, {
        status: 400,
        code: 'AGENT_VERSION_INVALID',
        message: error instanceof Error ? error.message : 'failed to roll back agent version',
      });
    }
  });

  router.get('/api/agents/:id/deployments', async (ctx) => {
    const agent = await scopedAgent(ctx, Number(ctx.params.id), 'agents.read');
    if (!agent) return;
    ctx.body = await agentVersionRepository.listDeployments(agent.id, agent.workspaceId);
  });

  router.put('/api/agents/:id/audience', async (ctx) => {
    const agentId = Number(ctx.params.id);
    const agent = await scopedAgent(ctx, agentId, 'agents.publish');
    if (!agent) return;
    try {
      const body = ctx.request.body as { audience?: unknown };
      const updated = await agentRepository.updateAudience(
        agentId,
        body.audience,
        currentWorkspaceId(ctx),
      );
      if (updated.status === 'generated') {
        const preview = await agentVersionRepository.createPreview(
          updated,
          ctx.state.authSession.user.id,
        );
        await agentVersionRepository.publish(
          updated,
          preview.version.id,
          ctx.state.authSession.user.id,
        );
      }
      ctx.body = await agentRepository.findByIdInWorkspace(agent.id, agent.workspaceId);
    } catch (error) {
      sendApiError(ctx, logger, {
        status: 400,
        code: 'AGENT_AUDIENCE_INVALID',
        message: error instanceof Error ? error.message : 'invalid audience',
      });
    }
  });

  router.post('/api/agents/:id/documents', async (ctx) => {
    const agentId = Number(ctx.params.id);
    if (!await scopedAgent(ctx, agentId, 'agents.write')) return;

    try {
      const input = ctx.request.body as CreateDocumentInput;
      const content = typeof input.content === 'string' ? input.content : '';
      const upload = parseDocumentUpload({
        filename: input.filename,
        mimeType: input.mimeType || 'text/plain',
        dataBase64: Buffer.from(content, 'utf8').toString('base64'),
        collection: input.collection,
      });
      await inspectDocumentUpload(ctx, agentId, upload);
      ctx.status = 201;
      ctx.body = await storeMeteredDocument(ctx, agentId, upload);
    } catch (error) {
      sendDocumentUploadError(ctx, error);
    }
  });

  router.post('/api/agents/:id/documents/upload', async (ctx) => {
    const agentId = Number(ctx.params.id);
    if (!await scopedAgent(ctx, agentId, 'agents.write')) return;

    try {
      const upload = parseDocumentUpload(ctx.request.body as Record<string, unknown>);
      await inspectDocumentUpload(ctx, agentId, upload);
      ctx.status = 201;
      ctx.body = await storeMeteredDocument(ctx, agentId, upload);
    } catch (error) {
      sendDocumentUploadError(ctx, error);
    }
  });

  router.get('/api/agents/:id/documents', async (ctx) => {
    const agentId = Number(ctx.params.id);
    if (!await scopedAgent(ctx, agentId, 'agents.read')) return;

    ctx.body = await documentRepository.listByAgent(agentId);
  });

  router.post('/api/agents/:id/documents/:documentId/index', async (ctx) => {
    const agentId = Number(ctx.params.id);
    const agent = await scopedAgent(ctx, agentId, 'agents.write');
    if (!agent) return;

    const documentId = Number(ctx.params.documentId);
    if (!await documentRepository.findByAgentDocument(agentId, documentId)) {
      sendApiError(ctx, logger, {
        status: 404,
        code: 'DOCUMENT_NOT_FOUND',
        message: 'document not found',
      });
      return;
    }

    const job = await jobRepository.create({
      type: 'document.index',
      workspaceId: agent.workspaceId,
      payload: { agentId, documentId },
    });
    const indexing = await documentRepository.markStatus(agentId, documentId, 'indexing');
    kickJobDispatcher();
    ctx.status = 202;
    ctx.body = {
      ...indexing,
      job,
    };
  });

  router.delete('/api/agents/:id/documents/:documentId', async (ctx) => {
    const agentId = Number(ctx.params.id);
    if (!await scopedAgent(ctx, agentId, 'agents.write')) return;

    const documentId = Number(ctx.params.documentId);
    const document = await documentRepository.findByAgentDocument(agentId, documentId);
    if (!document) {
      sendApiError(ctx, logger, {
        status: 404,
        code: 'DOCUMENT_NOT_FOUND',
        message: 'document not found',
      });
      return;
    }

    const removedIndexEntries = await documentIndexRepository.deleteByDocument(document.id);
    if (document.storageRef) {
      await documentStorage.delete(document.storageRef);
    }
    await documentRepository.deleteByAgentDocument(agentId, documentId);

    ctx.body = {
      documentId,
      deleted: true,
      removedIndexEntries,
    };
  });

  router.get('/api/agents/:id/conversations', async (ctx) => {
    const agentId = Number(ctx.params.id);
    if (!await scopedAgent(ctx, agentId, 'agents.read')) return;
    ctx.body = await conversationRepository.listByAgent(agentId);
  });

  router.post('/api/agents/:id/conversations', async (ctx) => {
    const agentId = Number(ctx.params.id);
    if (!await scopedAgent(ctx, agentId, 'agents.run')) return;
    const body = ctx.request.body as { title?: unknown };
    const title = typeof body.title === 'string' ? body.title : '新对话';
    ctx.status = 201;
    ctx.body = await conversationRepository.create(agentId, title);
  });

  router.get('/api/conversations/:id/messages', async (ctx) => {
    const conversationId = Number(ctx.params.id);
    if (!authorize(ctx, 'agents.read')) return;
    if (!await conversationRepository.findByIdInWorkspace(
      conversationId,
      currentWorkspaceId(ctx),
    )) {
      sendApiError(ctx, logger, {
        status: 404,
        code: 'CONVERSATION_NOT_FOUND',
        message: 'conversation not found',
      });
      return;
    }
    ctx.body = await conversationRepository.listMessages(conversationId);
  });

  router.get('/api/providers', (ctx) => {
    ctx.body = listProviders();
  });

  router.get('/api/provider-configs', async (ctx) => {
    if (!authorize(ctx, 'providers.manage')) return;
    ctx.body = await providerConfigRepository.list(currentWorkspaceId(ctx));
  });

  router.post('/api/provider-configs', async (ctx) => {
    if (!authorize(ctx, 'providers.manage')) return;
    try {
      const created = await providerConfigRepository.create(
        ctx.request.body as CreateProviderConfigInput,
        currentWorkspaceId(ctx),
      );
      ctx.status = 201;
      ctx.body = created;
    } catch (error) {
      sendApiError(ctx, logger, {
        status: 400,
        code: 'PROVIDER_CONFIG_INVALID',
        message: error instanceof Error ? error.message : 'failed to create provider config',
      });
    }
  });

  router.get('/api/provider-configs/:id', async (ctx) => {
    if (!authorize(ctx, 'providers.manage')) return;
    const config = await providerConfigRepository.findById(
      Number(ctx.params.id),
      currentWorkspaceId(ctx),
    );
    if (!config) {
      sendApiError(ctx, logger, {
        status: 404,
        code: 'PROVIDER_CONFIG_NOT_FOUND',
        message: 'provider config not found',
      });
      return;
    }

    ctx.body = config;
  });

  router.put('/api/provider-configs/:id', async (ctx) => {
    if (!authorize(ctx, 'providers.manage')) return;
    try {
      const updated = await providerConfigRepository.update(
        Number(ctx.params.id),
        ctx.request.body as UpdateProviderConfigInput,
        currentWorkspaceId(ctx),
      );
      if (!updated) {
        sendApiError(ctx, logger, {
          status: 404,
          code: 'PROVIDER_CONFIG_NOT_FOUND',
          message: 'provider config not found',
        });
        return;
      }

      ctx.body = updated;
    } catch (error) {
      sendApiError(ctx, logger, {
        status: 400,
        code: 'PROVIDER_CONFIG_INVALID',
        message: error instanceof Error ? error.message : 'failed to update provider config',
      });
    }
  });

  router.get('/api/tools', (ctx) => {
    ctx.body = listTools();
  });

  router.get('/api/skills', (ctx) => {
    ctx.body = listSkills();
  });

  router.get('/api/capabilities', async (ctx) => {
    if (!authorize(ctx, 'workspace.read')) return;
    try {
      const catalog = await fetchCapabilityCatalog(agentBaseUrl);
      const overrides = new Map(
        (await capabilitySettingsRepository.list(currentWorkspaceId(ctx)))
          .map((setting) => [setting.capabilityKey, setting.enabled]),
      );
      ctx.body = {
        ...catalog,
        capabilities: catalog.capabilities.map((capability) => ({
          ...capability,
          enabled: overrides.get(capabilityKey(capability)) ?? capability.status === 'available',
        })),
      };
    } catch (error) {
      sendApiError(ctx, logger, {
        status: 502,
        code: 'CAPABILITY_CATALOG_UNAVAILABLE',
        message: error instanceof Error ? error.message : 'capability catalog unavailable',
      });
    }
  });

  router.put('/api/capabilities/:kind/:name', async (ctx) => {
    if (!authorize(ctx, 'providers.manage')) return;
    const body = ctx.request.body as { enabled?: unknown };
    if (typeof body.enabled !== 'boolean') {
      sendApiError(ctx, logger, {
        status: 400,
        code: 'CAPABILITY_SETTING_INVALID',
        message: 'enabled must be a boolean',
      });
      return;
    }
    try {
      const catalog = await fetchCapabilityCatalog(agentBaseUrl);
      const key = `${ctx.params.kind}:${ctx.params.name}`;
      const capability = catalog.capabilities.find((item) => capabilityKey(item) === key);
      if (!capability) {
        sendApiError(ctx, logger, {
          status: 404,
          code: 'CAPABILITY_NOT_FOUND',
          message: 'capability not found',
        });
        return;
      }
      if (body.enabled && capability.status !== 'available') {
        sendApiError(ctx, logger, {
          status: 409,
          code: 'CAPABILITY_UNAVAILABLE',
          message: 'planned capabilities cannot be enabled',
        });
        return;
      }
      const setting = await capabilitySettingsRepository.set(
        currentWorkspaceId(ctx),
        key,
        body.enabled,
        currentUserId(ctx),
      );
      ctx.body = { ...capability, enabled: setting.enabled };
    } catch (error) {
      sendApiError(ctx, logger, {
        status: 502,
        code: 'CAPABILITY_CATALOG_UNAVAILABLE',
        message: error instanceof Error ? error.message : 'capability catalog unavailable',
      });
    }
  });

  router.post('/api/runs', async (ctx) => {
    if (!authorize(ctx, 'agents.run')) return;
    try {
      const body = ctx.request.body as CreateRunInput;
      const agent = await agentRepository.findByIdInWorkspace(
        Number(body.agentId),
        currentWorkspaceId(ctx),
      );
      if (!agent) {
        sendApiError(ctx, logger, {
          status: 404,
          code: 'RUN_AGENT_NOT_FOUND',
          message: 'agent not found',
        });
        return;
      }

      const requestedVersionId = parseOptionalPositiveInteger(body.agentVersionId);
      if (requestedVersionId === null) {
        sendApiError(ctx, logger, {
          status: 400,
          code: 'RUN_INVALID',
          message: 'agentVersionId must be a positive integer',
        });
        return;
      }
      const version = await agentVersionRepository.resolveForRun(
        agent.id,
        agent.workspaceId,
        requestedVersionId,
      );
      if (requestedVersionId && !version) {
        sendApiError(ctx, logger, {
          status: 404,
          code: 'RUN_AGENT_NOT_FOUND',
          message: 'agent version not found',
        });
        return;
      }

      const config = version?.config ?? agent.config;
      const providers = await runtimeProviderResolver.resolve(config, agent.workspaceId);
      const capabilitySnapshot = await capabilitySettingsRepository.snapshot(
        agent.workspaceId,
        capabilityKeysForConfig(config, providers),
      );
      capabilitySettingsRepository.assertEnabled(capabilitySnapshot);

      const created = await runRepository.create({
        ...body,
        agentVersionId: version?.id,
        capabilitySnapshot,
      });
      ctx.status = 201;
      ctx.body = created;
    } catch (error) {
      if (error instanceof CapabilityDisabledError) {
        sendApiError(ctx, logger, {
          status: 409,
          code: 'CAPABILITY_DISABLED',
          message: error.message,
          details: { capabilities: error.capabilityKeys },
        });
        return;
      }
      sendApiError(ctx, logger, {
        status: 400,
        code: 'RUN_INVALID',
        message: error instanceof Error ? error.message : 'failed to create run',
      });
    }
  });

  router.get('/api/runs/:id', async (ctx) => {
    if (!authorize(ctx, 'agents.read')) return;
    const run = await runRepository.findByIdInWorkspace(
      Number(ctx.params.id),
      currentWorkspaceId(ctx),
    );
    if (!run) {
      sendApiError(ctx, logger, {
        status: 404,
        code: 'RUN_NOT_FOUND',
        message: 'run not found',
      });
      return;
    }
    ctx.body = run;
  });

  router.get('/api/jobs/:id', async (ctx) => {
    if (!authorize(ctx, 'agents.read')) return;
    const job = await jobRepository.findByIdInWorkspace(
      Number(ctx.params.id),
      currentWorkspaceId(ctx),
    );
    if (!job) {
      sendApiError(ctx, logger, {
        status: 404,
        code: 'JOB_NOT_FOUND',
        message: 'job not found',
      });
      return;
    }

    ctx.body = job;
  });

  router.post('/api/runs/:id/events', async (ctx) => {
    const runId = Number(ctx.params.id);
    if (!authorize(ctx, 'agents.run')) return;
    if (!await runRepository.findByIdInWorkspace(runId, currentWorkspaceId(ctx))) {
      sendApiError(ctx, logger, {
        status: 404,
        code: 'RUN_NOT_FOUND',
        message: 'run not found',
      });
      return;
    }

    try {
      const body = ctx.request.body as Omit<CreateStreamEventInput, 'runId'>;
      const created = await streamEventRepository.create({
        runId,
        eventType: body.eventType,
        node: body.node,
        payload: body.payload,
      });
      await toolAuditRepository.recordStreamEvent(created);
      ctx.status = 201;
      ctx.body = created;
    } catch (error) {
      sendApiError(ctx, logger, {
        status: 400,
        code: 'RUN_EVENT_INVALID',
        message: error instanceof Error ? error.message : 'failed to create stream event',
      });
    }
  });

  router.get('/api/runs/:id/events', async (ctx) => {
    const runId = Number(ctx.params.id);
    if (!authorize(ctx, 'agents.read')) return;
    if (!await runRepository.findByIdInWorkspace(runId, currentWorkspaceId(ctx))) {
      sendApiError(ctx, logger, {
        status: 404,
        code: 'RUN_NOT_FOUND',
        message: 'run not found',
      });
      return;
    }

    ctx.body = await streamEventRepository.listByRunId(runId);
  });

  router.get('/api/audit/tool-calls', async (ctx) => {
    if (!authorize(ctx, 'audit.read')) return;
    const runId = parseOptionalPositiveInteger(ctx.query.runId);
    if (runId === null) {
      sendApiError(ctx, logger, {
        status: 400,
        code: 'RUN_ID_INVALID',
        message: 'runId must be a positive integer',
      });
      return;
    }

    if (runId && !await runRepository.findByIdInWorkspace(runId, currentWorkspaceId(ctx))) {
      sendApiError(ctx, logger, {
        status: 404,
        code: 'RUN_NOT_FOUND',
        message: 'run not found',
      });
      return;
    }
    ctx.body = await toolAuditRepository.list(currentWorkspaceId(ctx), runId);
  });

  async function replayRunStream(
    ctx: Koa.Context,
    run: RunRecord,
    afterEventId: number,
  ): Promise<void> {
    const events = await streamEventRepository.listByRunIdAfter(run.id, afterEventId);
    ctx.respond = false;
    const headers = runStreamHeaders(run);
    ctx.res.writeHead(200, headers);
    for (const event of events) {
      ctx.res.write(formatSseEvent({
        eventType: event.eventType,
        node: event.node,
        payload: event.payload,
      }, event.id));
    }
    ctx.res.end();
  }

  async function handleStream(
    ctx: Koa.Context,
    publicAgentId?: number,
  ): Promise<void> {
    if (!publicAgentId && !authorize(ctx, 'agents.run')) return;
    const publicAgent = publicAgentId
      ? await agentRepository.findById(publicAgentId)
      : null;
    const workspaceId = publicAgent?.workspaceId ?? currentWorkspaceId(ctx);
    const body = ctx.request.body as Record<string, unknown>;
    const storedAgentId = parseOptionalPositiveInteger(body.agentId);
    let runIdentity: { idempotencyKey: string; requestHash: string } | undefined;
    if (storedAgentId) {
      try {
        runIdentity = {
          idempotencyKey: normalizeIdempotencyKey(
            ctx.get('idempotency-key') || randomUUID(),
          ),
          requestHash: streamRequestHash(body),
        };
      } catch (error) {
        sendApiError(ctx, logger, {
          status: 400,
          code: 'RUN_INVALID',
          message: error instanceof Error ? error.message : 'invalid idempotency key',
        });
        return;
      }
      const existing = await runRepository.findByIdempotencyKey(
        workspaceId,
        runIdentity.idempotencyKey,
      );
      if (existing) {
        if (existing.requestHash !== runIdentity.requestHash) {
          sendApiError(ctx, logger, {
            status: 409,
            code: 'RUN_IDEMPOTENCY_CONFLICT',
            message: 'idempotency key was already used for a different request',
          });
          return;
        }
        if (['pending', 'running'].includes(existing.status)) {
          sendApiError(ctx, logger, {
            status: 409,
            code: 'RUN_IN_PROGRESS',
            message: 'run is still in progress',
          });
          return;
        }
        await replayRunStream(ctx, existing, lastEventId(ctx));
        return;
      }
    }

    ctx.respond = false;
    const streamHeaders: Record<string, string> = {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...(runIdentity
        ? { 'X-Primalthrum-Idempotency-Key': runIdentity.idempotencyKey }
        : {}),
    };

    const abortController = new AbortController();
    ctx.res.once('close', () => {
      if (!ctx.res.writableEnded) abortController.abort();
    });
    let currentRunId: number | null = null;
    let usageReserved = false;
    let finished = false;
    let sawAgentError = false;

    try {
      const streamRequest = await resolveStreamRequest(
        body,
        agentRepository,
        runRepository,
        workspaceId,
        agentVersionRepository,
        runtimeProviderResolver,
        capabilitySettingsRepository,
        runIdentity,
      );
      currentRunId = streamRequest.runId;
      let conversationId: number | null = null;
      if (streamRequest.runId) {
        try {
          await runUsageService.reserve({
            runId: streamRequest.runId,
            workspaceId,
            prompt: streamRequest.payload.goal,
            llm: streamRequest.payload.llm,
            channel: publicAgentId ? 'hosted' : 'api',
          });
          usageReserved = true;
        } catch (error) {
          if (error instanceof BillingError || error instanceof UsageRatingError) {
            throw new StreamRequestError(402, error.message);
          }
          throw error;
        }
        await runRepository.updateStatus(streamRequest.runId, 'running');
        const agentId = Number(body.agentId);
        const requestedConversationId = parseOptionalPositiveInteger(body.conversationId);
        if (requestedConversationId === null) {
          throw new StreamRequestError(400, 'conversationId must be a positive integer');
        }

        let conversation = requestedConversationId
          ? await conversationRepository.findByIdInWorkspace(requestedConversationId, workspaceId)
          : null;
        if (conversation && conversation.agentId !== agentId) {
          throw new StreamRequestError(404, 'conversation not found for agent');
        }
        if (!conversation) {
          conversation = await conversationRepository.create(
            agentId,
            String(body.input ?? '').slice(0, 120),
          );
        }
        conversationId = conversation.id;
        await runRepository.attachConversation(streamRequest.runId, conversationId);
        await conversationRepository.addMessage({
          conversationId,
          role: 'user',
          content: String(body.input ?? ''),
        });

        const agent = await agentRepository.findByIdInWorkspace(agentId, workspaceId);
        if (agent && !['none', 'null'].includes(streamRequest.payload.rag_provider)) {
          const vectorOptions = {
            embeddingProvider: streamRequest.payload.embedding.provider,
            embeddingModel: streamRequest.payload.embedding.model,
            vectorStore: streamRequest.payload.rag_provider,
          };
          const hasVectors = await documentIndexRepository.hasCompatibleVectors(
            agentId,
            vectorOptions,
          );
          const queryEmbedding = hasVectors
            ? await embeddingClient.embed(
                streamRequest.payload.embedding,
                [String(body.input ?? '')],
              )
            : null;
          if (queryEmbedding) {
            await runUsageService.recordEmbedding({
              runId: streamRequest.runId,
              workspaceId,
              provider: streamRequest.payload.embedding.provider,
              model: streamRequest.payload.embedding.model,
              tokenCount: queryEmbedding.inputTokens
                ?? Math.max(1, Math.ceil(String(body.input ?? '').length / 4)),
              purpose: 'query',
            });
          }
          const matches = queryEmbedding
            ? await documentIndexRepository.searchByAgent(
                agentId,
                String(body.input ?? ''),
                3,
                {
                  ...vectorOptions,
                  queryEmbedding: queryEmbedding.embeddings[0],
                },
              )
            : [];
          if (queryEmbedding) {
            await runUsageService.recordRetrieval({
              runId: streamRequest.runId,
              workspaceId,
              matchCount: matches.length,
            });
          }
          if (matches.length) {
            streamRequest.payload.context = matches
              .map((match) => `[${match.title}] ${match.text}`)
              .join('\n\n');
            streamRequest.payload.sources = matches.map((match) => ({
              title: match.title,
              documentId: match.documentId,
              chunkId: match.chunkId,
            }));
          }
        }

        streamHeaders['X-Primalthrum-Run-Id'] = String(streamRequest.runId);
        streamHeaders['X-Primalthrum-Conversation-Id'] = String(conversationId);
      }

      ctx.res.writeHead(200, streamHeaders);

      const upstream = await fetchAgent(agentBaseUrl, '/stream', {
        method: 'POST',
        headers: {
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(streamRequest.payload),
        signal: abortController.signal,
      });

      if (!upstream.ok) {
        const payload = {
          node: 'run',
          status: 'error',
          message: `Agent service returned HTTP ${upstream.status}`,
        };
        if (currentRunId) {
          const created = await streamEventRepository.create({
            runId: currentRunId,
            eventType: 'agent.error',
            node: 'run',
            payload,
          });
          ctx.res.write(formatSseEvent({
            eventType: created.eventType,
            node: created.node,
            payload: created.payload,
          }, created.id));
          await runRepository.updateStatus(currentRunId, 'failed', new Date().toISOString());
          finished = true;
        } else {
          ctx.res.write(sse('agent.error', payload));
        }
        return;
      }

      if (currentRunId) {
        await runUsageService.recordRun({
          runId: currentRunId,
          workspaceId,
          channel: publicAgentId ? 'hosted' : 'api',
        });
      }

      await pipeSseStream(upstream, ctx.res, streamRequest.runId
        ? async (event) => {
            const created = await streamEventRepository.create({
              runId: streamRequest.runId as number,
              eventType: event.eventType,
              node: event.node,
              payload: event.payload,
            });
            if (event.eventType === 'agent.error') sawAgentError = true;
            await toolAuditRepository.recordStreamEvent(created);
            if (event.eventType === 'agent.usage.reported') {
              await runUsageService.recordLlmUsage({
                runId: streamRequest.runId as number,
                workspaceId,
                provider: String(event.payload.provider ?? ''),
                model: String(event.payload.model ?? ''),
                inputTokens: nonNegativeEventInteger(event.payload.inputTokens),
                outputTokens: nonNegativeEventInteger(event.payload.outputTokens),
              });
            }
            if (event.eventType === 'agent.tool.called') {
              await runUsageService.recordToolCall({
                runId: streamRequest.runId as number,
                workspaceId,
                eventId: created.id,
                tool: String(event.payload.tool ?? event.payload.toolName ?? 'unknown'),
              });
            }
            if (
              conversationId
              && event.eventType === 'message.completed'
              && typeof event.payload.message === 'string'
            ) {
              await conversationRepository.addMessage({
                conversationId,
                role: 'assistant',
                content: event.payload.message,
                sources: conversationSourcesFromPayload(event.payload.sources),
              });
            }
            return created.id;
          }
        : undefined);
      if (currentRunId) {
        await runRepository.updateStatus(
          currentRunId,
          sawAgentError ? 'failed' : 'completed',
          new Date().toISOString(),
        );
      }
      finished = true;
    } catch (error) {
      if (!abortController.signal.aborted) {
        if (!ctx.res.headersSent) {
          ctx.res.writeHead(error instanceof StreamRequestError ? error.status : 200, streamHeaders);
        }

        const message = error instanceof StreamRequestError
          ? error.message
          : error instanceof Error ? error.message : 'Stream proxy failed';
        const payload = { node: 'run', status: 'error', message };
        if (currentRunId) {
          const created = await streamEventRepository.create({
            runId: currentRunId,
            eventType: 'agent.error',
            node: 'run',
            payload,
          });
          if (!ctx.res.writableEnded) {
            ctx.res.write(formatSseEvent({
              eventType: created.eventType,
              node: created.node,
              payload: created.payload,
            }, created.id));
          }
        } else {
          ctx.res.write(sse('agent.error', payload));
        }
      }
    } finally {
      if (currentRunId && !finished) {
        const status = abortController.signal.aborted ? 'cancelled' : 'failed';
        if (status === 'cancelled') {
          await streamEventRepository.create({
            runId: currentRunId,
            eventType: 'agent.run.cancelled',
            node: 'run',
            payload: {
              node: 'run',
              status,
              message: 'Agent run was cancelled after the client disconnected',
            },
          });
        }
        await runRepository.updateStatus(currentRunId, status, new Date().toISOString());
      }
      if (currentRunId && usageReserved) {
        try {
          await runUsageService.settle(currentRunId, workspaceId);
        } catch (error) {
          logger.log({
            level: 'error',
            code: 'RUN_USAGE_SETTLEMENT_FAILED',
            message: error instanceof Error ? error.message : 'run usage settlement failed',
            context: { runId: currentRunId, workspaceId },
          });
        }
      }
      ctx.res.end();
    }
  }

  router.post('/api/stream', async (ctx) => handleStream(ctx));
  router.post('/api/stream/create-agent', async (ctx) => handleStream(ctx));

  router.get('/api/runs/:id/stream', async (ctx) => {
    if (!authorize(ctx, 'agents.read')) return;
    const run = await runRepository.findByIdInWorkspace(
      Number(ctx.params.id),
      currentWorkspaceId(ctx),
    );
    if (!run) {
      sendApiError(ctx, logger, {
        status: 404,
        code: 'RUN_NOT_FOUND',
        message: 'run not found',
      });
      return;
    }
    await replayRunStream(ctx, run, lastEventId(ctx));
  });

  router.get('/api/public/agents/:slug', async (ctx) => {
    const agent = await agentRepository.findBySlug(ctx.params.slug);
    if (!isPublicAgent(agent)) {
      ctx.status = 404;
      ctx.body = { error: 'agent not found' };
      return;
    }
    ctx.body = {
      id: agent.id,
      name: agent.name,
      slug: agent.slug,
      description: agent.description,
      status: agent.status,
    };
  });

  router.post('/api/public/agents/:slug/stream', async (ctx) => {
    const agent = await agentRepository.findBySlug(ctx.params.slug);
    if (!isPublicAgent(agent)) {
      ctx.status = 404;
      ctx.body = { error: 'agent not found' };
      return;
    }
    const body = ctx.request.body as Record<string, unknown>;
    ctx.request.body = {
      agentId: agent.id,
      input: body.input,
      conversationId: body.conversationId,
    };
    await handleStream(ctx, agent.id);
  });

  app.use(router.routes());
  app.use(router.allowedMethods());

  return app;
}

function isDuplicateEmailError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const databaseError = error as Error & { code?: string; constraint?: string };
  return (
    databaseError.code === '23505'
    && databaseError.constraint === 'users_email_key'
  ) || /UNIQUE constraint failed: users\.email/i.test(error.message);
}

function teamEntitlementErrorCode(
  error: unknown,
): 'ENTITLEMENT_REQUIRED' | 'ENTITLEMENT_LIMIT_EXCEEDED' | null {
  if (!(error instanceof BillingError)) return null;
  return error.code === 'ENTITLEMENT_REQUIRED' || error.code === 'ENTITLEMENT_LIMIT_EXCEEDED'
    ? error.code
    : null;
}

function isPublicAgent(agent: AgentRecord | null): agent is AgentRecord {
  return Boolean(
    agent
    && agent.status === 'generated'
    && agent.config.audience === 'public',
  );
}

function conversationSourcesFromPayload(value: unknown): ConversationSource[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return [];
    const source = candidate as Record<string, unknown>;
    if (typeof source.title !== 'string' || !source.title.trim()) return [];
    return [{
      title: source.title.trim(),
      documentId: typeof source.documentId === 'number' ? source.documentId : undefined,
      chunkId: typeof source.chunkId === 'string' ? source.chunkId : undefined,
      url: typeof source.url === 'string' ? source.url : undefined,
    }];
  });
}

function nonNegativeEventInteger(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}
