import 'dotenv/config';

import { createApplicationRuntime, usesExternalWorker } from './src/applicationRuntime';
import { closeApp } from './src/services/appLifecycle';

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

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}; shutting down Primalthrum Node server`);
    const forceExit = setTimeout(() => {
      console.error('Primalthrum Node server shutdown timed out');
      process.exit(1);
    }, 10_000);
    forceExit.unref();
    server.close(async (serverError) => {
      let closeError: unknown = serverError;
      try {
        await closeApp(app);
      } catch (error) {
        closeError ??= error;
      }
      try {
        await database?.close();
      } catch (error) {
        closeError ??= error;
      }
      if (closeError) {
        console.error(closeError);
        process.exitCode = 1;
      }
      clearTimeout(forceExit);
    });
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Primalthrum Node server failed to start');
  process.exitCode = 1;
});
