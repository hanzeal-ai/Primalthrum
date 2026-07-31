import Koa from 'koa';
import Router from '@koa/router';
import bodyParser from 'koa-bodyparser';
import { join } from 'node:path';

import { SqliteDatabase } from './db/sqlite';
import { generateAgentProject } from './generators/agentProjectGenerator';
import { AgentRepository, type CreateAgentInput } from './services/agentRepository';
import { sendApiError } from './services/apiErrors';
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
import { RunRepository, type CreateRunInput } from './services/runRepository';
import { SessionRepository } from './services/sessionRepository';
import { pipeSseStream } from './services/sseRecorder';
import {
  StreamEventRepository,
  type CreateStreamEventInput,
} from './services/streamEventRepository';
import { ToolAuditRepository } from './services/toolAuditRepository';
import {
  resolveStreamRequest,
  StreamRequestError,
} from './services/streamRequestResolver';
import {
  normalizeEmail,
  toPublicUserRecord,
  UserRepository,
} from './services/userRepository';

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
  const runRepository = new RunRepository(db);
  const streamEventRepository = new StreamEventRepository(db);
  const documentRepository = new DocumentRepository(db);
  const documentIndexRepository = new DocumentIndexRepository(db);
  const documentStorage = new LocalDocumentStorage(
    options.documentStorageDir ?? DEFAULT_DOCUMENT_STORAGE_DIR,
  );
  const userRepository = new UserRepository(db);
  const sessionRepository = new SessionRepository(db);
  const providerConfigRepository = new ProviderConfigRepository(db);
  const toolAuditRepository = new ToolAuditRepository(db);
  const jobRepository = new JobRepository(db);
  const jobWorker = new InProcessJobWorker(jobRepository);

  app.use(async (ctx, next) => {
    const origin = ctx.get('origin');
    ctx.set('Access-Control-Allow-Origin', origin || '*');
    ctx.set('Access-Control-Allow-Credentials', 'true');
    ctx.set('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization');
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
      const user = userRepository.createAdmin(email, hashPassword(password));
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

      const publicUser = toPublicUserRecord(user);
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

  router.get('/api/agents', (ctx) => {
    ctx.body = agentRepository.list();
  });

  router.post('/api/agents', (ctx) => {
    try {
      const created = agentRepository.create(ctx.request.body as CreateAgentInput);
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
    if (!agent) {
      ctx.status = 404;
      ctx.body = { error: 'agent not found' };
      return;
    }
    ctx.body = agent;
  });

  router.get('/api/agents/:id', (ctx) => {
    const agent = agentRepository.findById(Number(ctx.params.id));
    if (!agent) {
      ctx.status = 404;
      ctx.body = { error: 'agent not found' };
      return;
    }
    ctx.body = agent;
  });

  router.post('/api/agents/:id/generate', async (ctx) => {
    const agent = agentRepository.findById(Number(ctx.params.id));
    if (!agent) {
      ctx.status = 404;
      ctx.body = { error: 'agent not found' };
      return;
    }

    const generated = await generateAgentProject(agent);
    agentRepository.markGenerated(agent.id);
    ctx.body = generated;
  });

  router.post('/api/agents/:id/documents', (ctx) => {
    const agentId = Number(ctx.params.id);
    if (!agentRepository.findById(agentId)) {
      sendApiError(ctx, logger, {
        status: 404,
        code: 'DOCUMENT_AGENT_NOT_FOUND',
        message: 'agent not found',
      });
      return;
    }

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
    if (!agentRepository.findById(agentId)) {
      sendApiError(ctx, logger, {
        status: 404,
        code: 'DOCUMENT_AGENT_NOT_FOUND',
        message: 'agent not found',
      });
      return;
    }

    ctx.body = documentRepository.listByAgent(agentId);
  });

  router.post('/api/agents/:id/documents/:documentId/index', (ctx) => {
    const agentId = Number(ctx.params.id);
    const agent = agentRepository.findById(agentId);
    if (!agent) {
      sendApiError(ctx, logger, {
        status: 404,
        code: 'DOCUMENT_AGENT_NOT_FOUND',
        message: 'agent not found',
      });
      return;
    }

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
    if (!agentRepository.findById(agentId)) {
      sendApiError(ctx, logger, {
        status: 404,
        code: 'DOCUMENT_AGENT_NOT_FOUND',
        message: 'agent not found',
      });
      return;
    }

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

  router.get('/api/providers', (ctx) => {
    ctx.body = listProviders();
  });

  router.get('/api/provider-configs', (ctx) => {
    ctx.body = providerConfigRepository.list();
  });

  router.post('/api/provider-configs', (ctx) => {
    try {
      const created = providerConfigRepository.create(
        ctx.request.body as CreateProviderConfigInput,
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
    const config = providerConfigRepository.findById(Number(ctx.params.id));
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
    try {
      const updated = providerConfigRepository.update(
        Number(ctx.params.id),
        ctx.request.body as UpdateProviderConfigInput,
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

  router.post('/api/runs', (ctx) => {
    try {
      const body = ctx.request.body as CreateRunInput;
      if (!agentRepository.findById(Number(body.agentId))) {
        sendApiError(ctx, logger, {
          status: 404,
          code: 'RUN_AGENT_NOT_FOUND',
          message: 'agent not found',
        });
        return;
      }

      const created = runRepository.create(body);
      ctx.status = 201;
      ctx.body = created;
    } catch (error) {
      sendApiError(ctx, logger, {
        status: 400,
        code: 'RUN_INVALID',
        message: error instanceof Error ? error.message : 'failed to create run',
      });
    }
  });

  router.get('/api/runs/:id', (ctx) => {
    const run = runRepository.findById(Number(ctx.params.id));
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
    const job = jobRepository.findById(Number(ctx.params.id));
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
    if (!runRepository.findById(runId)) {
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
    if (!runRepository.findById(runId)) {
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
    const runId = parseOptionalPositiveInteger(ctx.query.runId);
    if (runId === null) {
      sendApiError(ctx, logger, {
        status: 400,
        code: 'RUN_ID_INVALID',
        message: 'runId must be a positive integer',
      });
      return;
    }

    ctx.body = toolAuditRepository.list(runId);
  });

  async function handleStream(ctx: Koa.Context): Promise<void> {
    ctx.respond = false;
    const streamHeaders: Record<string, string> = {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    };

    const abortController = new AbortController();
    ctx.req.on('close', () => abortController.abort());

    try {
      const streamRequest = resolveStreamRequest(
        ctx.request.body,
        agentRepository,
        runRepository,
      );
      if (streamRequest.runId) {
        streamHeaders['X-Primalthrum-Run-Id'] = String(streamRequest.runId);
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
        ctx.res.write(
          sse('agent.error', {
            status: 'error',
            message: `Agent service returned HTTP ${upstream.status}`,
          }),
        );
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
            toolAuditRepository.recordStreamEvent(created);
          }
        : undefined);
    } catch (error) {
      if (!abortController.signal.aborted) {
        if (!ctx.res.headersSent) {
          ctx.res.writeHead(error instanceof StreamRequestError ? error.status : 200, streamHeaders);
        }

        if (error instanceof StreamRequestError) {
          ctx.res.write(
            sse('agent.error', {
              status: 'error',
              message: error.message,
            }),
          );
          return;
        }

        ctx.res.write(
          sse('agent.error', {
            status: 'error',
            message: error instanceof Error ? error.message : 'Stream proxy failed',
          }),
        );
      }
    } finally {
      ctx.res.end();
    }
  }

  router.post('/api/stream', handleStream);
  router.post('/api/stream/create-agent', handleStream);

  app.use(router.routes());
  app.use(router.allowedMethods());

  return app;
}
