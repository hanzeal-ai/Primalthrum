import { type default as Koa } from 'koa';

type AppCleanup = () => void | Promise<void>;

const appCleanups = new WeakMap<Koa, AppCleanup[]>();

export function registerAppCleanup(app: Koa, cleanup: AppCleanup): void {
  const cleanups = appCleanups.get(app) ?? [];
  cleanups.push(cleanup);
  appCleanups.set(app, cleanups);
}

export async function closeApp(app: Koa): Promise<void> {
  const cleanups = appCleanups.get(app) ?? [];
  appCleanups.delete(app);
  let firstError: unknown;
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup();
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) throw firstError;
}
