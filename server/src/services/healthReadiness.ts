import { type DatabaseAdapter } from '../db/adapter';
import { type AsyncDatabaseAdapter } from '../db/asyncAdapter';
import { type DocumentFileStorage } from './fileStorage';

export type ReadinessCheckStatus = 'ok' | 'failed';
export type ReadinessStatus = 'ready' | 'not_ready';

export interface ReadinessCheck {
  name: string;
  status: ReadinessCheckStatus;
  latencyMs: number;
  message?: string;
}

export interface ReadinessReport {
  status: ReadinessStatus;
  service: string;
  checks: ReadinessCheck[];
}

export async function checkServerReadiness(input: {
  db?: DatabaseAdapter;
  asyncDatabase?: AsyncDatabaseAdapter;
  agentBaseUrl: string;
  agentTimeoutMs?: number;
  documentStorage?: DocumentFileStorage;
}): Promise<ReadinessReport> {
  const checks: ReadinessCheck[] = [
    await checkDatabase(input),
    await checkAgentRuntime(input.agentBaseUrl, input.agentTimeoutMs ?? 1500),
  ];
  if (input.documentStorage) checks.push(await checkDocumentStorage(input.documentStorage));

  return {
    status: checks.every((check) => check.status === 'ok') ? 'ready' : 'not_ready',
    service: 'server',
    checks,
  };
}

async function checkDocumentStorage(storage: DocumentFileStorage): Promise<ReadinessCheck> {
  const startedAt = Date.now();
  try {
    await storage.healthCheck();
    return { name: 'document_storage', status: 'ok', latencyMs: Date.now() - startedAt };
  } catch (error) {
    return {
      name: 'document_storage',
      status: 'failed',
      latencyMs: Date.now() - startedAt,
      message: error instanceof Error ? error.message : 'document storage probe failed',
    };
  }
}

async function checkDatabase(input: {
  db?: DatabaseAdapter;
  asyncDatabase?: AsyncDatabaseAdapter;
}): Promise<ReadinessCheck> {
  const startedAt = Date.now();
  try {
    const rows = input.asyncDatabase
      ? await input.asyncDatabase.query<{ ok: number }>({ text: 'SELECT 1 AS ok;' })
      : input.db?.query<{ ok: number }>('SELECT 1 AS ok;');
    if (!rows) throw new Error('database probe is not configured');
    if (Number(rows[0]?.ok) !== 1) {
      throw new Error('database probe returned an unexpected result');
    }
    return {
      name: 'database',
      status: 'ok',
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      name: 'database',
      status: 'failed',
      latencyMs: Date.now() - startedAt,
      message: error instanceof Error ? error.message : 'database probe failed',
    };
  }
}

async function checkAgentRuntime(
  agentBaseUrl: string,
  timeoutMs: number,
): Promise<ReadinessCheck> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${trimTrailingSlash(agentBaseUrl)}/ready`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`agent readiness returned ${response.status}`);
    }
    return {
      name: 'agent_runtime',
      status: 'ok',
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      name: 'agent_runtime',
      status: 'failed',
      latencyMs: Date.now() - startedAt,
      message: error instanceof Error ? error.message : 'agent readiness failed',
    };
  } finally {
    clearTimeout(timeout);
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
