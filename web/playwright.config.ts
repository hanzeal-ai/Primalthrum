import { defineConfig, devices } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const currentDir = dirname(fileURLToPath(import.meta.url))
const e2eRoot = resolve(currentDir, '..', '.e2e')

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'line',
  globalSetup: './e2e/globalSetup.ts',
  outputDir: 'test-results',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop-chromium',
      grep: /@desktop/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile-chromium',
      grep: /@mobile/,
      use: { ...devices['Pixel 5'] },
    },
  ],
  webServer: [
    {
      command: '../agent/.venv/bin/python -m uvicorn main:app --app-dir ../agent --host 127.0.0.1 --port 48100',
      url: 'http://127.0.0.1:48100/ready',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'pnpm --dir ../server exec ts-node tests/support/browserE2eServer.ts',
      url: 'http://127.0.0.1:43100/health',
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        AGENT_BASE_URL: 'http://127.0.0.1:48100',
        PORT: '43100',
        PRIMALTHRUM_E2E_ROOT: e2eRoot,
      },
    },
    {
      command: 'pnpm dev --host 127.0.0.1 --port 4173',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        VITE_SERVER_PROXY_TARGET: 'http://127.0.0.1:43100',
      },
    },
  ],
})
