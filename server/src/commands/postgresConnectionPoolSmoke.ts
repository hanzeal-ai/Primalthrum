import assert from 'node:assert/strict';

import { PostgresDatabase } from '../db/postgres';
import { type AsyncDatabaseSession } from '../db/asyncAdapter';

const CONNECTION_TIMEOUT_MS = 300;

interface BackendRow {
  backend_id: number;
}

interface RecoveryRow {
  recovered: number;
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');

  const database = new PostgresDatabase({
    connectionString,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: 1_000,
    max: 2,
  });
  const firstGate = deferred<void>();
  const secondGate = deferred<void>();
  const poolSaturated = deferred<void>();
  const backendIds = new Set<number>();
  let acquiredConnections = 0;

  const holdConnection = async (
    session: AsyncDatabaseSession,
    gate: Promise<void>,
  ): Promise<void> => {
    const rows = await session.query<BackendRow>({
      text: 'SELECT pg_backend_pid() AS backend_id;',
    });
    const backendId = Number(rows[0]?.backend_id);
    assert.ok(Number.isSafeInteger(backendId) && backendId > 0);
    backendIds.add(backendId);
    acquiredConnections += 1;
    if (acquiredConnections === 2) poolSaturated.resolve();
    await gate;
  };

  const firstTransaction = database.transaction((session) => (
    holdConnection(session, firstGate.promise)
  ));
  const secondTransaction = database.transaction((session) => (
    holdConnection(session, secondGate.promise)
  ));

  try {
    await withTimeout(poolSaturated.promise, 3_000, 'PostgreSQL pool did not saturate');
    assert.equal(backendIds.size, 2);

    const exhaustionStartedAt = Date.now();
    await assert.rejects(
      database.query({ text: 'SELECT 1 AS unavailable;' }),
      (error: unknown) => (
        error instanceof Error
        && /timeout exceeded when trying to connect|connection timeout/i.test(error.message)
      ),
    );
    const exhaustionTimeoutMs = Date.now() - exhaustionStartedAt;
    assert.ok(exhaustionTimeoutMs >= CONNECTION_TIMEOUT_MS - 50);
    assert.ok(exhaustionTimeoutMs < 2_000);

    firstGate.resolve();
    await firstTransaction;
    const recoveryStartedAt = Date.now();
    const recovered = await database.query<RecoveryRow>({ text: 'SELECT 1 AS recovered;' });
    const recoveryElapsedMs = Date.now() - recoveryStartedAt;
    assert.equal(Number(recovered[0]?.recovered), 1);
    assert.ok(recoveryElapsedMs < CONNECTION_TIMEOUT_MS);

    secondGate.resolve();
    await secondTransaction;
    const healthy = await database.query<RecoveryRow>({ text: 'SELECT 1 AS recovered;' });
    assert.equal(Number(healthy[0]?.recovered), 1);

    process.stdout.write(`${JSON.stringify({
      status: 'passed',
      poolMax: 2,
      backendConnections: backendIds.size,
      configuredTimeoutMs: CONNECTION_TIMEOUT_MS,
      exhaustionTimeoutMs,
      recoveryElapsedMs,
    })}\n`);
  } finally {
    firstGate.resolve();
    secondGate.resolve();
    await Promise.allSettled([firstTransaction, secondTransaction]);
    await database.close();
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

async function withTimeout(
  operation: Promise<void>,
  timeoutMs: number,
  message: string,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'PostgreSQL pool smoke failed'}\n`);
  process.exitCode = 1;
});
