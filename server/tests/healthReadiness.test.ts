import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { type DatabaseAdapter } from '../src/db/adapter';
import { type DocumentMalwareScanner } from '../src/services/documentMalwareScanner';
import { checkServerReadiness } from '../src/services/healthReadiness';

test('server readiness fails when the required malware scanner is unavailable', async () => {
  const agent = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ status: 'ready', service: 'agent' }));
  });
  await new Promise<void>((resolve) => agent.listen(0, '127.0.0.1', resolve));
  const address = agent.address();
  assert(address && typeof address === 'object');

  const scanner: DocumentMalwareScanner = {
    name: 'unavailable-test',
    async healthCheck() {
      throw new Error('document malware scanner is unavailable');
    },
    async scan() {
      return { scanner: this.name };
    },
  };
  const database: DatabaseAdapter = {
    columns: () => [],
    dialect: 'sqlite',
    query: <T extends object>() => [{ ok: 1 }] as T[],
    run: () => undefined,
  };

  try {
    const report = await checkServerReadiness({
      agentBaseUrl: `http://127.0.0.1:${address.port}`,
      db: database,
      documentMalwareScanner: scanner,
    });

    assert.equal(report.status, 'not_ready');
    assert.deepEqual(
      report.checks.map((check) => [check.name, check.status]),
      [
        ['database', 'ok'],
        ['agent_runtime', 'ok'],
        ['malware_scanner', 'failed'],
      ],
    );
  } finally {
    await new Promise<void>((resolve) => agent.close(() => resolve()));
  }
});
