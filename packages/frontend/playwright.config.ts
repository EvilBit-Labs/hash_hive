import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  // demo-capture is a recipe for regenerating docs/feature_demo/operator-console-login.gif,
  // not behavior coverage. Excluding it from the default suite avoids
  // cross-test state leakage in CI's sequential worker mode: the demo writes
  // users.last_project_id via POST /projects/select, which the backend's
  // BetterAuth session.create.before hook then rehydrates on subsequent
  // sign-ins, breaking tests that assume a fresh multi-project user.
  // Re-record locally with: PLAYWRIGHT_INCLUDE_DEMO=1 bunx playwright test demo-capture.spec.ts
  testIgnore: process.env['PLAYWRIGHT_INCLUDE_DEMO'] ? [] : ['**/demo-capture.spec.ts'],
  globalSetup: './e2e/setup/global-setup.ts',
  globalTeardown: './e2e/setup/global-teardown.ts',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  workers: process.env['CI'] ? 1 : undefined,
  reporter: 'html',
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'bun run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env['CI'],
  },
})
