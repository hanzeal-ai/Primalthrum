import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { createApp } from '../../src/app';
import {
  BROWSER_E2E_WEBHOOK_SECRET,
  BrowserE2ePaymentAdapter,
} from './browserE2ePaymentAdapter';

const rootDir = resolve(
  process.env.PRIMALTHRUM_E2E_ROOT ?? '../.e2e',
);
const port = Number(process.env.PORT ?? 43100);
const publicAppUrl = 'http://127.0.0.1:4173';

rmSync(rootDir, { recursive: true, force: true });
mkdirSync(rootDir, { recursive: true });

const server = createApp({
  agentBaseUrl: process.env.AGENT_BASE_URL ?? 'http://127.0.0.1:48100',
  dbPath: resolve(rootDir, 'platform.sqlite'),
  documentStorageDir: resolve(rootDir, 'documents'),
  exposeAccountEmailPreview: true,
  generatedAgentsDir: resolve(rootDir, 'generated-agents'),
  operatorBootstrapToken: 'browser-e2e-operator-bootstrap-token-0001',
  paymentAdapter: new BrowserE2ePaymentAdapter(publicAppUrl),
  paymentPriceRefs: { pro: 'price_pro', team: 'price_team' },
  publicAppUrl,
  stripeWebhookSecret: BROWSER_E2E_WEBHOOK_SECRET,
}).listen(port, '127.0.0.1', () => {
  console.log(`Primalthrum browser E2E server listening on http://127.0.0.1:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
