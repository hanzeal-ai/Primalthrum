import Koa from 'koa';
import Router from '@koa/router';
import bodyParser from 'koa-bodyparser';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { SqliteDatabase } from './db/sqlite';
import { generateAgentProject } from './generators/agentProjectGenerator';
import { AgentRepository, type CreateAgentInput } from './services/agentRepository';
import { AgentVersionRepository } from './services/agentVersionRepository';
import { sendApiError } from './services/apiErrors';
import {
  capabilityKey,
  fetchCapabilityCatalog,
} from './services/capabilityCatalogClient';
import {
  CapabilityDisabledError,
  CapabilitySettingsRepository,
} from './services/capabilitySettingsRepository';
import {
  ConversationRepository,
  type ConversationSource,
} from './services/conversationRepository';
import {
  clearSessionCookie,
  createAuthMiddleware,
  extractSessionToken,
  sessionCookie,
} from './services/authMiddleware';
import {
  DocumentRepository,
  type CreateDocumentInput,
} from './services/documentRepository';
import { DocumentIndexRepository } from './services/documentIndexRepository';
import { LocalDocumentStorage } from './services/fileStorage';
import { checkServerReadiness } from './services/healthReadiness';
import { JsonConsoleLogger, type StructuredLogger } from './services/logger';
import { MetricsRegistry } from './services/metricsRegistry';
import { hashPassword, verifyPassword } from './services/passwordHash';
import { InProcessJobWorker } from './services/inProcessJobWorker';
import { JobRepository } from './services/jobRepository';
import {
  ProviderConfigRepository,
  type CreateProviderConfigInput,
  type UpdateProviderConfigInput,
} from './services/providerConfigRepository';
import { listProviders, listSkills, listTools } from './services/discoveryCatalog';
import {
  RunRepository,
  type CreateRunInput,
  type RunRecord,
} from './services/runRepository';
import { SessionRepository } from './services/sessionRepository';
import { formatSseEvent, pipeSseStream } from './services/sseRecorder';
import {
  StreamEventRepository,
  type CreateStreamEventInput,
} from './services/streamEventRepository';
import { ToolAuditRepository } from './services/toolAuditRepository';
import {
  capabilityKeysForConfig,
  resolveStreamRequest,
  StreamRequestError,
} from './services/streamRequestResolver';
import {
  normalizeEmail,
  UserRepository,
} from './services/userRepository';
import { hasWorkspacePermission, type WorkspacePermission } from './services/workspaceAuthorization';
import { WorkspaceRepository } from './services/workspaceRepository';
import { LocalSecretVault } from './services/localSecretVault';
import { RuntimeProviderResolver } from './services/runtimeProviderResolver';

export interface AppOptions {
  agentBaseUrl?: string;
  dbPath?: string;
  documentStorageDir?: string;
  generatedAgentsDir?: string;
  logger?: StructuredLogger;
  metrics?: MetricsRegistry;
}

const DEFAULT_AGENT_BASE_URL = 'http://127.0.0.1:8000';
const DEFAULT_DB_PATH = join(process.cwd(), '..', 'data', 'platform.sqlite');
const DEFAULT_DOCUMENT_STORAGE_DIR = join(process.cwd(), '..', 'data', 'documents');
const DEFAULT_GENERATED_AGENTS_DIR = join(process.cwd(), '..', 'generated-agents');

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
  const agentBaseUrl = options.agentBaseUrl ?? DEFAULT_AGENT_BASE_URL;
  const logger = options.logger ?? new JsonConsoleLogger();
  const metrics = options.metrics ?? new MetricsRegistry();
  const db = new SqliteDatabase(options.dbPath ?? DEFAULT_DB_PATH);
  const agentRepository = new AgentRepository(
    db,
    options.generatedAgentsDir ?? DEFAULT_GENERATED_AGENTS_DIR,
  );
  const agentVersionRepository = new AgentVersionRepository(db);
  const runRepository = new RunRepository(db);
  const streamEventRepository = new StreamEventRepository(db);
  const documentRepository = new DocumentRepository(db);
  const documentIndexRepository = new DocumentIndexRepository(db);
  const conversationRepository = new ConversationRepository(db);
  const documentStorage = new LocalDocumentStorage(
    options.documentStorageDir ?? DEFAULT_DOCUMENT_STORAGE_DIR,
  );
  const userRepository = new UserRepository(db);
  const workspaceRepository = new WorkspaceRepository(db);
  const sessionRepository = new SessionRepository(db);
  const providerConfigRepository = new ProviderConfigRepository(db);
  const runtimeProviderResolver = new RuntimeProviderResolver(
    providerConfigRepository,
    new LocalSecretVault(db),
  );
  const capabilitySettingsRepository = new CapabilitySettingsRepository(db);
  const toolAuditRepository = new ToolAuditRepository(db);
  const jobRepository = new JobRepository(db);
  const jobWorker = new InProcessJobWorker(jobRepository);

  function authorize(ctx: Koa.Context, permission: WorkspacePermission): boolean {
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

  function scopedAgent(
    ctx: Koa.Context,
    id: number,
    permission: WorkspacePermission,
  ) {
    if (!authorize(ctx, permission)) return null;
    const agent = agentRepository.findByIdInWorkspace(id, currentWorkspaceId(ctx));
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

  app.use(async (ctx, next) => {
    const origin = ctx.get('origin');
    ctx.set('Access-Control-Allow-Origin', origin || '*');
    ctx.set('Access-Control-Allow-Credentials', 'true');
    ctx.set(
      'Access-Control-Allow-Headers',
      'Content-Type, Accept, Authorization, Idempotency-Key, Last-Event-ID',
    );
    ctx.set(
      'Access-Control-Expose-Headers',
      'X-Primalthrum-Run-Id, X-Primalthrum-Conversation-Id, X-Primalthrum-Idempotency-Key',
    );
    ctx.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    ctx.set('Vary', 'Origin');

    if (ctx.method === 'OPTIONS') {
      ctx.status = 204;
      return;
    }

    await next();
  });
  app.use(bodyParser());
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
  app.use(createAuthMiddleware(sessionRepository));

  router.get('/health', (ctx) => {
    ctx.body = {
      status: 'ok',
      service: 'server',
      agentBaseUrl,
    };
  });

  router.get('/ready', async (ctx) => {
    const report = await checkServerReadiness({ db, agentBaseUrl });
    ctx.status = report.status === 'ready' ? 200 : 503;
    ctx.body = report;
  });

  router.get('/metrics', (ctx) => {
    ctx.type = 'text/plain; version=0.0.4';
    ctx.body = metrics.toPrometheusText();
  });

  router.get('/api/setup/status', (ctx) => {
    ctx.body = {
      needsSetup: !userRepository.hasAdmin(),
    };
  });

  router.post('/api/setup/admin', (ctx) => {
    try {
      if (userRepository.hasAdmin()) {
        ctx.status = 409;
        ctx.body = { error: 'admin user already exists' };
        return;
      }

      const body = ctx.request.body as { email?: unknown; password?: unknown };
      const email = normalizeEmail(body.email);
      const password = normalizePassword(body.password);
      const createdUser = userRepository.createAdmin(email, hashPassword(password));
      const user = workspaceRepository.principalForUser(createdUser.id);
      if (!user) throw new Error('admin workspace membership could not be loaded');
      const session = sessionRepository.create(user);

      ctx.set('Set-Cookie', sessionCookie(session.token, session.expiresAt));
      ctx.status = 201;
      ctx.body = { user, session };
    } catch (error) {
      ctx.status = 400;
      ctx.body = {
        error: error instanceof Error ? error.message : 'failed to create admin',
      };
    }
  });

  router.post('/api/auth/login', (ctx) => {
    try {
      const body = ctx.request.body as { email?: unknown; password?: unknown };
      const email = normalizeEmail(body.email);
      const password = normalizePassword(body.password);
      const user = userRepository.findByEmail(email);

      if (!user || !verifyPassword(password, user.passwordHash)) {
        ctx.status = 401;
        ctx.body = { error: 'invalid email or password' };
        return;
      }

      const publicUser = workspaceRepository.principalForUser(user.id);
      if (!publicUser) {
        ctx.status = 403;
        ctx.body = { error: 'workspace membership is required' };
        return;
      }
      const session = sessionRepository.create(publicUser);
      ctx.set('Set-Cookie', sessionCookie(session.token, session.expiresAt));
      ctx.body = { user: publicUser, session };
    } catch (error) {
      ctx.status = 400;
      ctx.body = {
        error: error instanceof Error ? error.message : 'failed to login',
      };
    }
  });

  router.post('/api/auth/logout', (ctx) => {
    const token = extractSessionToken(ctx);
    if (token) {
      sessionRepository.revokeToken(token);
    }

    ctx.set('Set-Cookie', clearSessionCookie());
    ctx.status = 204;
  });

  router.get('/api/auth/session', (ctx) => {
    const token = extractSessionToken(ctx);
    const session = token ? sessionRepository.findByToken(token) : null;
    if (!session) {
      ctx.status = 401;
      ctx.body = { error: 'authentication required' };
      return;
    }

    ctx.body = session;
  });

  router.post('/api/auth/workspace', (ctx) => {
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
      sessionRepository.switchWorkspace(token, authSession.user.id, workspaceId);
      const selected = sessionRepository.findByToken(token);
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

  router.get('/api/workspaces', (ctx) => {
    if (!authorize(ctx, 'workspace.read')) return;
    ctx.body = workspaceRepository.listForUser(ctx.state.authSession.user.id);
  });

  router.post('/api/workspaces', (ctx) => {
    const authSession = ctx.state.authSession;
    const token = ctx.state.sessionToken;
    if (!authSession || !token) return;
    try {
      const body = ctx.request.body as { name?: unknown };
      const workspace = workspaceRepository.create(authSession.user.id, body.name);
      sessionRepository.switchWorkspace(token, authSession.user.id, workspace.id);
      ctx.status = 201;
      ctx.body = {
        workspace,
        session: sessionRepository.findByToken(token),
      };
    } catch (error) {
      sendApiError(ctx, logger, {
        status: 400,
        code: 'WORKSPACE_INVALID',
        message: error instanceof Error ? error.message : 'failed to create workspace',
      });
    }
  });

  router.get('/api/workspaces/:id/members', (ctx) => {
    const workspaceId = Number(ctx.params.id);
    if (!requireCurrentWorkspace(ctx, workspaceId) || !authorize(ctx, 'workspace.read')) return;
    ctx.body = workspaceRepository.listMembers(workspaceId);
  });

  router.patch('/api/workspaces/:id/members/:userId', (ctx) => {
    const workspaceId = Number(ctx.params.id);
    if (!requireCurrentWorkspace(ctx, workspaceId) || !authorize(ctx, 'members.manage')) return;
    try {
      const body = ctx.request.body as { role?: unknown };
      ctx.body = workspaceRepository.updateMemberRole(
        workspaceId,
        Number(ctx.params.userId),
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

  router.delete('/api/workspaces/:id/members/:userId', (ctx) => {
    const workspaceId = Number(ctx.params.id);
    if (!requireCurrentWorkspace(ctx, workspaceId) || !authorize(ctx, 'members.manage')) return;
    try {
      workspaceRepository.removeMember(workspaceId, Number(ctx.params.userId));
      ctx.status = 204;
    } catch (error) {
      sendApiError(ctx, logger, {
        status: 400,
        code: 'WORKSPACE_MEMBER_INVALID',
        message: error instanceof Error ? error.message : 'failed to remove member',
      });
    }
  });

  router.get('/api/workspaces/:id/invitations', (ctx) => {
    const workspaceId = Number(ctx.params.id);
    if (!requireCurrentWorkspace(ctx, workspaceId) || !authorize(ctx, 'members.manage')) return;
    ctx.body = workspaceRepository.listInvitations(workspaceId);
  });

  router.post('/api/workspaces/:id/invitations', (ctx) => {
    const workspaceId = Number(ctx.params.id);
    if (!requireCurrentWorkspace(ctx, workspaceId) || !authorize(ctx, 'members.manage')) return;
    try {
      const body = ctx.request.body as { email?: unknown; role?: unknown };
      ctx.status = 201;
      ctx.body = workspaceRepository.createInvitation({
        workspaceId,
        email: body.email,
        role: body.role,
        invitedByUserId: ctx.state.authSession.user.id,
      });
    } catch (error) {
      sendApiError(ctx, logger, {
        status: 400,
        code: 'WORKSPACE_INVITATION_INVALID',
        message: error instanceof Error ? error.message : 'failed to create invitation',
      });
    }
  });

  router.post('/api/invitations/accept', (ctx) => {
    try {
      const body = ctx.request.body as { token?: unknown; password?: unknown };
      const token = typeof body.token === 'string' ? body.token : '';
      const invitation = workspaceRepository.activeInvitationByToken(token);
      if (!invitation) throw new Error('invitation is invalid or expired');
      const password = normalizePassword(body.password);
      let user = userRepository.findByEmail(invitation.email);
      if (user && !verifyPassword(password, user.passwordHash)) {
        ctx.status = 401;
        ctx.body = { error: 'invalid email or password' };
        return;
      }
      user ??= userRepository.createUser(invitation.email, hashPassword(password));
      workspaceRepository.acceptInvitation(token, user.id, user.email);
      const principal = workspaceRepository.principalForUser(user.id, invitation.workspaceId);
      if (!principal) throw new Error('workspace membership could not be loaded');
      const session = sessionRepository.create(principal);
      ctx.set('Set-Cookie', sessionCookie(session.token, session.expiresAt));
      ctx.status = 201;
      ctx.body = { user: principal, session };
    } catch (error) {
      sendApiError(ctx, logger, {
        status: 400,
        code: 'WORKSPACE_INVITATION_INVALID',
        message: error instanceof Error ? error.message : 'failed to accept invitation',
      });
    }
  });

  router.get('/api/agents', (ctx) => {
    if (!authorize(ctx, 'agents.read')) return;
    ctx.body = agentRepository.list(currentWorkspaceId(ctx));
  });

  router.post('/api/agents', (ctx) => {
    if (!authorize(ctx, 'agents.write')) return;
    try {
      const created = agentRepository.create(
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

  router.get('/api/agents/slug/:slug', (ctx) => {
    const agent = agentRepository.findBySlug(ctx.params.slug);
    if (!authorize(ctx, 'agents.read')) return;
    if (!agent || agent.workspaceId !== currentWorkspaceId(ctx)) {
      ctx.status = 404;
      ctx.body = { error: 'agent not found' };
      return;
    }
    ctx.body = agent;
  });

  router.get('/api/agents/:id', (ctx) => {
    const agent = scopedAgent(ctx, Number(ctx.params.id), 'agents.read');
    if (!agent) return;
    ctx.body = agent;
  });

  router.post('/api/agents/:id/generate', async (ctx) => {
    const agent = scopedAgent(ctx, Number(ctx.params.id), 'agents.write');
    if (!agent) return;

    const generated = await generateAgentProject(agent);
    const generatedAgent = agentRepository.markGenerated(agent.id);
    const preview = agentVersionRepository.createPreview(
      generatedAgent,
      ctx.state.authSession.user.id,
    );
    agentVersionRepository.publish(
      generatedAgent,
      preview.version.id,
      ctx.state.authSession.user.id,
    );
    ctx.body = generated;
  });

  router.get('/api/agents/:id/versions', (ctx) => {
    const agent = scopedAgent(ctx, Number(ctx.params.id), 'agents.read');
    if (!agent) return;
    ctx.body = agentVersionRepository.listVersions(agent.id, agent.workspaceId);
  });

  router.post('/api/agents/:id/versions', (ctx) => {
    const agent = scopedAgent(ctx, Number(ctx.params.id), 'agents.write');
    if (!agent) return;
    try {
      ctx.status = 201;
      ctx.body = agentVersionRepository.createPreview(
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

  router.post('/api/agents/:id/versions/:versionId/publish', (ctx) => {
    const agent = scopedAgent(ctx, Number(ctx.params.id), 'agents.publish');
    if (!agent) return;
    try {
      ctx.body = agentVersionRepository.publish(
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

  router.post('/api/agents/:id/versions/:versionId/rollback', (ctx) => {
    const agent = scopedAgent(ctx, Number(ctx.params.id), 'agents.publish');
    if (!agent) return;
    try {
      ctx.body = agentVersionRepository.publish(
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

  router.get('/api/agents/:id/deployments', (ctx) => {
    const agent = scopedAgent(ctx, Number(ctx.params.id), 'agents.read');
    if (!agent) return;
    ctx.body = agentVersionRepository.listDeployments(agent.id, agent.workspaceId);
  });

  router.put('/api/agents/:id/audience', (ctx) => {
    const agentId = Number(ctx.params.id);
    const agent = scopedAgent(ctx, agentId, 'agents.publish');
    if (!agent) return;
    try {
      const body = ctx.request.body as { audience?: unknown };
      const updated = agentRepository.updateAudience(
        agentId,
        body.audience,
        currentWorkspaceId(ctx),
      );
      if (updated.status === 'generated') {
        const preview = agentVersionRepository.createPreview(
          updated,
          ctx.state.authSession.user.id,
        );
        agentVersionRepository.publish(
          updated,
          preview.version.id,
          ctx.state.authSession.user.id,
        );
      }
      ctx.body = agentRepository.findByIdInWorkspace(agent.id, agent.workspaceId);
    } catch (error) {
      sendApiError(ctx, logger, {
        status: 400,
        code: 'AGENT_AUDIENCE_INVALID',
        message: error instanceof Error ? error.message : 'invalid audience',
      });
    }
  });

  router.post('/api/agents/:id/documents', (ctx) => {
    const agentId = Number(ctx.params.id);
    if (!scopedAgent(ctx, agentId, 'agents.write')) return;

    try {
      const input = ctx.request.body as CreateDocumentInput;
      const created = documentRepository.create(
        agentId,
        input,
      );
      const stored = documentStorage.save({
        workspaceId: created.workspaceId,
        agentId: created.agentId,
        documentId: created.id,
        filename: created.filename,
        content: input.content ?? '',
      });
      const withStorage = documentRepository.attachStorageRef(
        agentId,
        created.id,
        stored.storageRef,
      );
      ctx.status = 201;
      ctx.body = withStorage ?? created;
    } catch (error) {
      sendApiError(ctx, logger, {
        status: 400,
        code: 'DOCUMENT_INVALID',
        message: error instanceof Error ? error.message : 'failed to register document',
      });
    }
  });

  router.get('/api/agents/:id/documents', (ctx) => {
    const agentId = Number(ctx.params.id);
    if (!scopedAgent(ctx, agentId, 'agents.read')) return;

    ctx.body = documentRepository.listByAgent(agentId);
  });

  router.post('/api/agents/:id/documents/:documentId/index', (ctx) => {
    const agentId = Number(ctx.params.id);
    const agent = scopedAgent(ctx, agentId, 'agents.write');
    if (!agent) return;

    const documentId = Number(ctx.params.documentId);
    if (!documentRepository.findByAgentDocument(agentId, documentId)) {
      sendApiError(ctx, logger, {
        status: 404,
        code: 'DOCUMENT_NOT_FOUND',
        message: 'document not found',
      });
      return;
    }

    let indexed = documentRepository.findByAgentDocument(agentId, documentId);
    const job = jobRepository.create({
      type: 'document.index',
      workspaceId: agent.workspaceId,
      payload: { agentId, documentId },
    });
    const completedJob = jobWorker.run(job.id, () => {
      const existing = documentRepository.findByAgentDocument(agentId, documentId);
      const content = existing?.storageRef
        ? documentStorage.read(existing.storageRef)
        : '';
      const entries = existing
        ? documentIndexRepository.reindex(existing, content)
        : [];
      indexed = documentRepository.markIndexed(agentId, documentId);
      if (!indexed) {
        throw new Error('document not found');
      }
      return { document: indexed, indexEntryCount: entries.length };
    });

    if (completedJob.status !== 'succeeded' || !indexed) {
      sendApiError(ctx, logger, {
        status: 500,
        code: 'DOCUMENT_INDEX_FAILED',
        message: completedJob.error || 'document index failed',
        details: { job: completedJob },
      });
      return;
    }

    ctx.body = {
      ...indexed,
      job: completedJob,
    };
  });

  router.delete('/api/agents/:id/documents/:documentId', (ctx) => {
    const agentId = Number(ctx.params.id);
    if (!scopedAgent(ctx, agentId, 'agents.write')) return;

    const documentId = Number(ctx.params.documentId);
    const document = documentRepository.findByAgentDocument(agentId, documentId);
    if (!document) {
      sendApiError(ctx, logger, {
        status: 404,
        code: 'DOCUMENT_NOT_FOUND',
        message: 'document not found',
      });
      return;
    }

    const removedIndexEntries = documentIndexRepository.deleteByDocument(document.id);
    if (document.storageRef) {
      documentStorage.delete(document.storageRef);
    }
    documentRepository.deleteByAgentDocument(agentId, documentId);

    ctx.body = {
      documentId,
      deleted: true,
      removedIndexEntries,
    };
  });

  router.get('/api/agents/:id/conversations', (ctx) => {
    const agentId = Number(ctx.params.id);
    if (!scopedAgent(ctx, agentId, 'agents.read')) return;
    ctx.body = conversationRepository.listByAgent(agentId);
  });

  router.post('/api/agents/:id/conversations', (ctx) => {
    const agentId = Number(ctx.params.id);
    if (!scopedAgent(ctx, agentId, 'agents.run')) return;
    const body = ctx.request.body as { title?: unknown };
    const title = typeof body.title === 'string' ? body.title : '新对话';
    ctx.status = 201;
    ctx.body = conversationRepository.create(agentId, title);
  });

  router.get('/api/conversations/:id/messages', (ctx) => {
    const conversationId = Number(ctx.params.id);
    if (!authorize(ctx, 'agents.read')) return;
    if (!conversationRepository.findByIdInWorkspace(conversationId, currentWorkspaceId(ctx))) {
      sendApiError(ctx, logger, {
        status: 404,
        code: 'CONVERSATION_NOT_FOUND',
        message: 'conversation not found',
      });
      return;
    }
    ctx.body = conversationRepository.listMessages(conversationId);
  });

  router.get('/api/providers', (ctx) => {
    ctx.body = listProviders();
  });

  router.get('/api/provider-configs', (ctx) => {
    if (!authorize(ctx, 'providers.manage')) return;
    ctx.body = providerConfigRepository.list(currentWorkspaceId(ctx));
  });

  router.post('/api/provider-configs', (ctx) => {
    if (!authorize(ctx, 'providers.manage')) return;
    try {
      const created = providerConfigRepository.create(
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

  router.get('/api/provider-configs/:id', (ctx) => {
    if (!authorize(ctx, 'providers.manage')) return;
    const config = providerConfigRepository.findById(
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

  router.put('/api/provider-configs/:id', (ctx) => {
    if (!authorize(ctx, 'providers.manage')) return;
    try {
      const updated = providerConfigRepository.update(
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
        capabilitySettingsRepository.list(currentWorkspaceId(ctx))
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
      const setting = capabilitySettingsRepository.set(
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

  router.post('/api/runs', (ctx) => {
    if (!authorize(ctx, 'agents.run')) return;
    try {
      const body = ctx.request.body as CreateRunInput;
      const agent = agentRepository.findByIdInWorkspace(
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
      const version = agentVersionRepository.resolveForRun(
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
      const providers = runtimeProviderResolver.resolve(config, agent.workspaceId);
      const capabilitySnapshot = capabilitySettingsRepository.snapshot(
        agent.workspaceId,
        capabilityKeysForConfig(config, providers),
      );
      capabilitySettingsRepository.assertEnabled(capabilitySnapshot);

      const created = runRepository.create({
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

  router.get('/api/runs/:id', (ctx) => {
    if (!authorize(ctx, 'agents.read')) return;
    const run = runRepository.findByIdInWorkspace(
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

  router.get('/api/jobs/:id', (ctx) => {
    if (!authorize(ctx, 'agents.read')) return;
    const job = jobRepository.findByIdInWorkspace(
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

  router.post('/api/runs/:id/events', (ctx) => {
    const runId = Number(ctx.params.id);
    if (!authorize(ctx, 'agents.run')) return;
    if (!runRepository.findByIdInWorkspace(runId, currentWorkspaceId(ctx))) {
      sendApiError(ctx, logger, {
        status: 404,
        code: 'RUN_NOT_FOUND',
        message: 'run not found',
      });
      return;
    }

    try {
      const body = ctx.request.body as Omit<CreateStreamEventInput, 'runId'>;
      const created = streamEventRepository.create({
        runId,
        eventType: body.eventType,
        node: body.node,
        payload: body.payload,
      });
      toolAuditRepository.recordStreamEvent(created);
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

  router.get('/api/runs/:id/events', (ctx) => {
    const runId = Number(ctx.params.id);
    if (!authorize(ctx, 'agents.read')) return;
    if (!runRepository.findByIdInWorkspace(runId, currentWorkspaceId(ctx))) {
      sendApiError(ctx, logger, {
        status: 404,
        code: 'RUN_NOT_FOUND',
        message: 'run not found',
      });
      return;
    }

    ctx.body = streamEventRepository.listByRunId(runId);
  });

  router.get('/api/audit/tool-calls', (ctx) => {
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

    if (runId && !runRepository.findByIdInWorkspace(runId, currentWorkspaceId(ctx))) {
      sendApiError(ctx, logger, {
        status: 404,
        code: 'RUN_NOT_FOUND',
        message: 'run not found',
      });
      return;
    }
    ctx.body = toolAuditRepository.list(currentWorkspaceId(ctx), runId);
  });

  function replayRunStream(
    ctx: Koa.Context,
    run: RunRecord,
    afterEventId: number,
  ): void {
    ctx.respond = false;
    const headers = runStreamHeaders(run);
    ctx.res.writeHead(200, headers);
    for (const event of streamEventRepository.listByRunIdAfter(run.id, afterEventId)) {
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
      ? agentRepository.findById(publicAgentId)
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
      const existing = runRepository.findByIdempotencyKey(
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
        replayRunStream(ctx, existing, lastEventId(ctx));
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
    let finished = false;
    let sawAgentError = false;

    try {
      const streamRequest = resolveStreamRequest(
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
        runRepository.updateStatus(streamRequest.runId, 'running');
        const agentId = Number(body.agentId);
        const requestedConversationId = parseOptionalPositiveInteger(body.conversationId);
        if (requestedConversationId === null) {
          throw new StreamRequestError(400, 'conversationId must be a positive integer');
        }

        let conversation = requestedConversationId
          ? conversationRepository.findByIdInWorkspace(requestedConversationId, workspaceId)
          : null;
        if (conversation && conversation.agentId !== agentId) {
          throw new StreamRequestError(404, 'conversation not found for agent');
        }
        if (!conversation) {
          conversation = conversationRepository.create(
            agentId,
            String(body.input ?? '').slice(0, 120),
          );
        }
        conversationId = conversation.id;
        runRepository.attachConversation(streamRequest.runId, conversationId);
        conversationRepository.addMessage({
          conversationId,
          role: 'user',
          content: String(body.input ?? ''),
        });

        const agent = agentRepository.findByIdInWorkspace(agentId, workspaceId);
        if (agent && !['none', 'null'].includes(streamRequest.payload.rag_provider)) {
          const matches = documentIndexRepository.searchByAgent(
            agentId,
            String(body.input ?? ''),
          );
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

      const upstream = await fetch(`${agentBaseUrl}/stream`, {
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
          const created = streamEventRepository.create({
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
          runRepository.updateStatus(currentRunId, 'failed', new Date().toISOString());
          finished = true;
        } else {
          ctx.res.write(sse('agent.error', payload));
        }
        return;
      }

      await pipeSseStream(upstream, ctx.res, streamRequest.runId
        ? (event) => {
            const created = streamEventRepository.create({
              runId: streamRequest.runId as number,
              eventType: event.eventType,
              node: event.node,
              payload: event.payload,
            });
            if (event.eventType === 'agent.error') sawAgentError = true;
            toolAuditRepository.recordStreamEvent(created);
            if (
              conversationId
              && event.eventType === 'message.completed'
              && typeof event.payload.message === 'string'
            ) {
              conversationRepository.addMessage({
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
        runRepository.updateStatus(
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
          const created = streamEventRepository.create({
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
          streamEventRepository.create({
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
        runRepository.updateStatus(currentRunId, status, new Date().toISOString());
      }
      ctx.res.end();
    }
  }

  router.post('/api/stream', async (ctx) => handleStream(ctx));
  router.post('/api/stream/create-agent', async (ctx) => handleStream(ctx));

  router.get('/api/runs/:id/stream', (ctx) => {
    if (!authorize(ctx, 'agents.read')) return;
    const run = runRepository.findByIdInWorkspace(
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
    replayRunStream(ctx, run, lastEventId(ctx));
  });

  router.get('/api/public/agents/:slug', (ctx) => {
    const agent = agentRepository.findBySlug(ctx.params.slug);
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
    const agent = agentRepository.findBySlug(ctx.params.slug);
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

function isPublicAgent(agent: ReturnType<AgentRepository['findBySlug']>): agent is NonNullable<typeof agent> {
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
