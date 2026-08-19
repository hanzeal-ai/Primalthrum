import 'dotenv/config';

import { createApplicationRuntime, usesExternalWorker } from './src/applicationRuntime';
import { HttpServerLifecycle } from './src/services/httpServerLifecycle';

const port = Number(process.env.PORT ?? 3000);

async function main(): Promise<void> {
  const runtime = await createApplicationRuntime(process.env, {
    startBackgroundSchedulers: !usesExternalWorker(process.env),
  });
  const { agentBaseUrl, app, database, databaseProvider } = runtime;

  const server = app.listen(port, () => {
    console.log(`Primalthrum Node server listening on http://127.0.0.1:${port}`);
    console.log(`Agent upstream: ${agentBaseUrl}`);
    console.log(`Database provider: ${databaseProvider}`);
  });

  const lifecycle = new HttpServerLifecycle({ app, database, server });
  const shutdown = (signal: NodeJS.Signals): void => {
    void lifecycle.shutdown(signal).catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Primalthrum Node server failed to start');
  process.exitCode = 1;
});
