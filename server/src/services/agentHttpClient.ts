import { activeTraceparent } from './activeTraceContext';

export function fetchAgent(
  agentBaseUrl: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    throw new Error('Agent request path must be an absolute local path');
  }

  const headers = new Headers(init.headers);
  headers.delete('traceparent');
  const traceparent = activeTraceparent();
  if (traceparent) headers.set('traceparent', traceparent);

  return fetch(`${agentBaseUrl.replace(/\/$/, '')}${path}`, {
    ...init,
    headers,
  });
}
