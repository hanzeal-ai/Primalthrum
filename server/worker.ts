import 'dotenv/config';

import { createApplicationRuntime } from './src/applicationRuntime';
import { closeApp } from './src/services/appLifecycle';

async function main(): Promise<void> {
  const runtime = await createApplicationRuntime(process.env, {
    backgroundTimersUnref: false,
    startBackgroundSchedulers: true,
  });
  console.log(`Primalthrum worker started with ${runtime.databaseProvider}`);

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}; shutting down Primalthrum worker`);
    let closeError: unknown;
    try {
      await closeApp(runtime.app);
    } catch (error) {
      closeError = error;
    }
    try {
      await runtime.database?.close();
    } catch (error) {
      closeError ??= error;
    }
    if (closeError) {
      console.error(closeError);
      process.exitCode = 1;
    }
  };

  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Primalthrum worker failed to start');
  process.exitCode = 1;
});
