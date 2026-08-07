import assert from 'node:assert/strict';
import test from 'node:test';

import Koa from 'koa';

import { closeApp, registerAppCleanup } from '../src/services/appLifecycle';

test('application cleanup runs in reverse registration order and only once', async () => {
  const app = new Koa();
  const calls: string[] = [];
  registerAppCleanup(app, () => { calls.push('database'); });
  registerAppCleanup(app, async () => { calls.push('scheduler'); });

  await closeApp(app);
  await closeApp(app);

  assert.deepEqual(calls, ['scheduler', 'database']);
});

test('application cleanup continues after failure and preserves the first error', async () => {
  const app = new Koa();
  const calls: string[] = [];
  registerAppCleanup(app, () => { calls.push('database'); });
  registerAppCleanup(app, () => {
    calls.push('scheduler');
    throw new Error('scheduler cleanup failed');
  });

  await assert.rejects(closeApp(app), /scheduler cleanup failed/);
  assert.deepEqual(calls, ['scheduler', 'database']);
});
