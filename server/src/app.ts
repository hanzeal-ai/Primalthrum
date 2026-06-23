import Koa from 'koa';
import Router from '@koa/router';
import bodyParser from 'koa-bodyparser';

export interface AppOptions {
  agentBaseUrl?: string;
}

interface StreamPayload {
  goal: string;
  agent: string;
  tools: string[];
}

const DEFAULT_AGENT_BASE_URL = 'http://127.0.0.1:8000';

function toText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function toTools(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  if (typeof value === 'string') {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }

  return [];
}

function normalizePayload(body: unknown): StreamPayload {
  const candidate = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const goal = toText(candidate.goal ?? candidate.task_desc, '');

  if (!goal) {
    throw new Error('goal is required');
  }

  return {
    goal,
    agent: toText(candidate.agent ?? candidate.agent_name, 'ResearchAgent'),
    tools: toTools(candidate.tools),
  };
}

function sse(event: string, payload: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

async function writeUpstreamStream(
  response: Response,
  downstream: NodeJS.WritableStream,
): Promise<void> {
  if (!response.body) {
    throw new Error('Agent stream response has no body');
  }

  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    downstream.write(Buffer.from(value));
  }
}

export function createApp(options: AppOptions = {}): Koa {
  const app = new Koa();
  const router = new Router();
  const agentBaseUrl = options.agentBaseUrl ?? DEFAULT_AGENT_BASE_URL;

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

  async function handleStream(ctx: Koa.Context): Promise<void> {
    ctx.respond = false;
    ctx.res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const abortController = new AbortController();
    ctx.req.on('close', () => abortController.abort());

    try {
      const payload = normalizePayload(ctx.request.body);
      const upstream = await fetch(`${agentBaseUrl}/stream`, {
        method: 'POST',
        headers: {
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
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

      await writeUpstreamStream(upstream, ctx.res);
    } catch (error) {
      if (!abortController.signal.aborted) {
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
