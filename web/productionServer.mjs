import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import {
  Agent as HttpAgent,
  createServer,
  request as httpRequest,
} from 'node:http';
import {
  Agent as HttpsAgent,
  request as httpsRequest,
} from 'node:https';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_DIST_DIR = fileURLToPath(new URL('./dist/', import.meta.url));
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

export function createProductionServer(options = {}) {
  const distDir = resolve(options.distDir ?? process.env.WEB_DIST_DIR ?? DEFAULT_DIST_DIR);
  const proxyTarget = validatedProxyTarget(
    options.proxyTarget ?? process.env.SERVER_PROXY_TARGET ?? 'http://127.0.0.1:3000',
  );
  const proxyTimeoutMs = boundedInteger(
    options.proxyTimeoutMs ?? process.env.PROXY_TIMEOUT_MS ?? 120_000,
    1_000,
    600_000,
    'PROXY_TIMEOUT_MS',
  );
  const forwardedProto = validatedForwardedProto(
    options.forwardedProto ?? process.env.FORWARDED_PROTO ?? 'https',
  );
  const logger = options.logger ?? console;
  const httpAgent = new HttpAgent({ keepAlive: true });
  const httpsAgent = new HttpsAgent({ keepAlive: true });

  const server = createServer(async (request, response) => {
    const rawRequestUrl = request.url ?? '/';
    if (!rawRequestUrl.startsWith('/') || rawRequestUrl.startsWith('//')) {
      setSecurityHeaders(response);
      sendJson(response, 400, { error: 'invalid request target' });
      return;
    }
    const requestUrl = new URL(rawRequestUrl, 'http://web.local');
    if (requestUrl.pathname === '/healthz') {
      setSecurityHeaders(response);
      sendJson(response, 200, { status: 'ok', service: 'web' });
      return;
    }
    if (requestUrl.pathname === '/api' || requestUrl.pathname.startsWith('/api/')) {
      proxyApiRequest({
        request,
        requestUrl,
        response,
        proxyTarget,
        proxyTimeoutMs,
        logger,
        httpAgent,
        httpsAgent,
        forwardedProto,
      });
      return;
    }
    try {
      await serveStatic(request, response, distDir, requestUrl.pathname);
    } catch (error) {
      logger.error(JSON.stringify({
        level: 'error',
        code: 'WEB_STATIC_DELIVERY_FAILED',
        message: error instanceof Error ? error.message : 'static delivery failed',
      }));
      if (!response.headersSent) sendJson(response, 500, { error: 'internal server error' });
      else response.destroy();
    }
  });
  server.on('close', () => {
    httpAgent.destroy();
    httpsAgent.destroy();
  });
  return server;
}

async function serveStatic(request, response, distDir, pathname) {
  setSecurityHeaders(response);
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    sendJson(response, 405, { error: 'method not allowed' });
    return;
  }
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    sendJson(response, 400, { error: 'invalid path' });
    return;
  }
  if (decodedPath.includes('\0')) {
    sendJson(response, 400, { error: 'invalid path' });
    return;
  }
  const relativePath = decodedPath.replace(/^\/+/, '') || 'index.html';
  let filePath = resolve(distDir, relativePath);
  if (!withinDirectory(distDir, filePath)) {
    sendJson(response, 400, { error: 'invalid path' });
    return;
  }
  let fileStat = await fileStatOrNull(filePath);
  if (fileStat?.isDirectory()) {
    filePath = resolve(filePath, 'index.html');
    fileStat = await fileStatOrNull(filePath);
  }
  if (!fileStat?.isFile() && !extname(relativePath)) {
    filePath = resolve(distDir, 'index.html');
    fileStat = await fileStatOrNull(filePath);
  }
  if (!fileStat?.isFile()) {
    sendJson(response, 404, { error: 'not found' });
    return;
  }
  response.statusCode = 200;
  response.setHeader('Content-Type', MIME_TYPES.get(extname(filePath).toLowerCase()) ?? 'application/octet-stream');
  response.setHeader('Content-Length', String(fileStat.size));
  response.setHeader(
    'Cache-Control',
    filePath.includes(`${sep}assets${sep}`)
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
  );
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  createReadStream(filePath)
    .on('error', (error) => response.destroy(error))
    .pipe(response);
}

function proxyApiRequest(input) {
  const target = new URL(
    `${input.requestUrl.pathname}${input.requestUrl.search}`,
    input.proxyTarget.origin,
  );
  const headers = forwardedHeaders(
    input.request.headers,
    input.request.socket.remoteAddress,
    target.host,
    input.forwardedProto,
  );
  const requestImpl = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const agent = target.protocol === 'https:' ? input.httpsAgent : input.httpAgent;
  const upstream = requestImpl(target, {
    method: input.request.method,
    headers,
    agent,
  }, (upstreamResponse) => {
    input.response.statusCode = upstreamResponse.statusCode ?? 502;
    for (const [name, value] of Object.entries(upstreamResponse.headers)) {
      if (!HOP_BY_HOP_HEADERS.has(name) && typeof value !== 'undefined') {
        input.response.setHeader(name, value);
      }
    }
    upstreamResponse.pipe(input.response);
  });
  upstream.setTimeout(input.proxyTimeoutMs, () => {
    upstream.destroy(new Error('upstream request timed out'));
  });
  upstream.on('error', (error) => {
    input.logger.error(JSON.stringify({
      level: 'error',
      code: 'WEB_API_PROXY_FAILED',
      message: error.message,
    }));
    if (!input.response.headersSent) {
      setSecurityHeaders(input.response);
      sendJson(input.response, 502, { error: 'upstream unavailable' });
    } else {
      input.response.destroy();
    }
  });
  input.request.on('aborted', () => upstream.destroy());
  input.request.pipe(upstream);
}

function forwardedHeaders(sourceHeaders, remoteAddress, targetHost, forwardedProto) {
  const headers = {};
  for (const [name, value] of Object.entries(sourceHeaders)) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && typeof value !== 'undefined') {
      headers[name] = value;
    }
  }
  const priorForwardedFor = sourceHeaders['x-forwarded-for'];
  const forwardedFor = [
    Array.isArray(priorForwardedFor) ? priorForwardedFor.join(', ') : priorForwardedFor,
    remoteAddress,
  ].filter(Boolean).join(', ');
  headers.host = targetHost;
  if (forwardedFor) headers['x-forwarded-for'] = forwardedFor;
  headers['x-forwarded-host'] = String(sourceHeaders.host ?? '');
  headers['x-forwarded-proto'] = forwardedProto;
  return headers;
}

function setSecurityHeaders(response) {
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; "
      + "frame-src https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com; "
      + "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; "
      + "font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
  );
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=(self)');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', String(Buffer.byteLength(body)));
  response.end(body);
}

async function fileStatOrNull(path) {
  try {
    return await stat(path);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return null;
    throw error;
  }
}

function withinDirectory(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function validatedProxyTarget(value) {
  const target = new URL(String(value));
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error('SERVER_PROXY_TARGET must use http or https');
  }
  if (target.username || target.password) {
    throw new Error('SERVER_PROXY_TARGET must not contain credentials');
  }
  return target;
}

function validatedForwardedProto(value) {
  const normalized = String(value).trim().toLowerCase();
  if (normalized !== 'http' && normalized !== 'https') {
    throw new Error('FORWARDED_PROTO must be http or https');
  }
  return normalized;
}

function boundedInteger(value, minimum, maximum, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function isEntrypoint() {
  return Boolean(process.argv[1])
    && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
}

if (isEntrypoint()) {
  const host = process.env.HOST ?? '0.0.0.0';
  const port = boundedInteger(process.env.PORT ?? 8080, 1, 65_535, 'PORT');
  const server = createProductionServer();
  server.listen(port, host, () => {
    console.log(JSON.stringify({
      level: 'info',
      code: 'WEB_SERVER_STARTED',
      message: `Primalthrum Web listening on ${host}:${port}`,
    }));
  });
  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    const timeout = setTimeout(() => process.exit(1), 10_000);
    timeout.unref();
    server.close((error) => {
      clearTimeout(timeout);
      if (error) {
        console.error(error);
        process.exitCode = 1;
      }
    });
    console.log(JSON.stringify({
      level: 'info',
      code: 'WEB_SERVER_STOPPING',
      message: `Received ${signal}`,
    }));
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}
