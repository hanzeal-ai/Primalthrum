import Koa from 'koa';
import Router from '@koa/router';
import bodyParser from 'koa-bodyparser';
import { join } from 'node:path';

import { SqliteDatabase } from './db/sqlite';
import { generateAgentProject } from './generators/agentProjectGenerator';
import { AgentRepository, type CreateAgentInput } from './services/agentRepository';
import {
  DocumentRepository,
  type CreateDocumentInput,
} from './services/documentRepository';
import { listProviders, listSkills, listTools } from './services/discoveryCatalog';
import { RunRepository, type CreateRunInput } from './services/runRepository';
import { pipeSseStream } from './services/sseRecorder';
import {
  StreamEventRepository,
  type CreateStreamEventInput,
} from './services/streamEventRepository';
import {
  resolveStreamRequest,
  StreamRequestError,
} from './services/streamRequestResolver';

export interface AppOptions {
  agentBaseUrl?: string;
  dbPath?: string;
  generatedAgentsDir?: string;
}

const DEFAULT_AGENT_BASE_URL = 'http://127.0.0.1:8000';
const DEFAULT_DB_PATH = join(process.cwd(), '..', 'data', 'platform.sqlite');
const DEFAULT_GENERATED_AGENTS_DIR = join(process.cwd(), '..', 'generated-agents');

function sse(event: string, payload: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export function createApp(options: AppOptions = {}): Koa {
  const app = new Koa();
  const router = new Router();
  const agentBaseUrl = options.agentBaseUrl ?? DEFAULT_AGENT_BASE_URL;
  const db = new SqliteDatabase(options.dbPath ?? DEFAULT_DB_PATH);
  const agentRepository = new AgentRepository(
    db,
    options.generatedAgentsDir ?? DEFAULT_GENERATED_AGENTS_DIR,
  );
  const runRepository = new RunRepository(db);
  const streamEventRepository = new StreamEventRepository(db);
  const documentRepository = new DocumentRepository(db);

  app.use(async (ctx, next) => {
    ctx.set('Access-Control-Allow-Origin', '*');
    ctx.set('Access-Control-Allow-Headers', 'Content-Type, Accept');
    ctx.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

    if (ctx.method === 'OPTIONS') {
      ctx.status = 204;
      return;
    }

    await next();
  });
  app.use(bodyParser());

  router.get('/health', (ctx) => {
    ctx.body = {
      status: 'ok',
      service: 'server',
      agentBaseUrl,
    };
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
      ctx.status = 404;
      ctx.body = { error: 'agent not found' };
      return;
    }

    try {
      const created = documentRepository.create(
        agentId,
        ctx.request.body as CreateDocumentInput,
      );
      ctx.status = 201;
      ctx.body = created;
    } catch (error) {
      ctx.status = 400;
      ctx.body = {
        error: error instanceof Error ? error.message : 'failed to register document',
      };
    }
  });

  router.get('/api/agents/:id/documents', (ctx) => {
    const agentId = Number(ctx.params.id);
    if (!agentRepository.findById(agentId)) {
      ctx.status = 404;
      ctx.body = { error: 'agent not found' };
      return;
    }

    ctx.body = documentRepository.listByAgent(agentId);
  });

  router.get('/api/providers', (ctx) => {
    ctx.body = listProviders();
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
        ctx.status = 404;
        ctx.body = { error: 'agent not found' };
        return;
      }

      const created = runRepository.create(body);
      ctx.status = 201;
      ctx.body = created;
    } catch (error) {
      ctx.status = 400;
      ctx.body = {
        error: error instanceof Error ? error.message : 'failed to create run',
      };
    }
  });

  router.get('/api/runs/:id', (ctx) => {
    const run = runRepository.findById(Number(ctx.params.id));
    if (!run) {
      ctx.status = 404;
      ctx.body = { error: 'run not found' };
      return;
    }
    ctx.body = run;
  });

  router.post('/api/runs/:id/events', (ctx) => {
    const runId = Number(ctx.params.id);
    if (!runRepository.findById(runId)) {
      ctx.status = 404;
      ctx.body = { error: 'run not found' };
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
      ctx.status = 201;
      ctx.body = created;
    } catch (error) {
      ctx.status = 400;
      ctx.body = {
        error: error instanceof Error ? error.message : 'failed to create stream event',
      };
    }
  });

  router.get('/api/runs/:id/events', (ctx) => {
    const runId = Number(ctx.params.id);
    if (!runRepository.findById(runId)) {
      ctx.status = 404;
      ctx.body = { error: 'run not found' };
      return;
    }

    ctx.body = streamEventRepository.listByRunId(runId);
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
            streamEventRepository.create({
              runId: streamRequest.runId as number,
              eventType: event.eventType,
              node: event.node,
              payload: event.payload,
            });
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
