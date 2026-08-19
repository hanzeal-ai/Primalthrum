import { type Server } from 'node:http';

import { type default as Koa } from 'koa';

import { type AsyncDatabaseAdapter } from '../db/asyncAdapter';
import { closeApp } from './appLifecycle';

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

interface LifecycleLogger {
  error(message: unknown): void;
  log(message: string): void;
}

export interface HttpServerLifecycleOptions {
  app: Koa;
  database?: Pick<AsyncDatabaseAdapter, 'close'>;
  logger?: LifecycleLogger;
  onTimeout?: () => void;
  server: Server;
  shutdownTimeoutMs?: number;
}

export class HttpServerLifecycle {
  private readonly logger: LifecycleLogger;
  private readonly onTimeout: () => void;
  private readonly shutdownTimeoutMs: number;
  private shutdownPromise: Promise<void> | undefined;

  constructor(private readonly options: HttpServerLifecycleOptions) {
    this.logger = options.logger ?? console;
    this.onTimeout = options.onTimeout ?? (() => process.exit(1));
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.shutdownTimeoutMs) || this.shutdownTimeoutMs < 1) {
      throw new Error('HTTP server shutdown timeout is invalid');
    }
  }

  shutdown(signal: NodeJS.Signals): Promise<void> {
    this.shutdownPromise ??= this.performShutdown(signal);
    return this.shutdownPromise;
  }

  private async performShutdown(signal: NodeJS.Signals): Promise<void> {
    this.logger.log(`Received ${signal}; shutting down Primalthrum Node server`);
    let timeout: NodeJS.Timeout | undefined;
    const timeoutFailure = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        const error = new Error('Primalthrum Node server shutdown timed out');
        this.logger.error(error.message);
        try {
          this.onTimeout();
        } catch (timeoutError) {
          reject(timeoutError);
          return;
        }
        reject(error);
      }, this.shutdownTimeoutMs);
      timeout.unref();
    });
    try {
      await Promise.race([this.drainAndClose(), timeoutFailure]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async drainAndClose(): Promise<void> {
    let firstError: unknown;
    try {
      await closeHttpServer(this.options.server);
    } catch (error) {
      firstError = error;
    }
    try {
      await closeApp(this.options.app);
    } catch (error) {
      firstError ??= error;
    }
    try {
      await this.options.database?.close();
    } catch (error) {
      firstError ??= error;
    }
    if (firstError) throw firstError;
  }
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
