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
  // `workers: 1` enforced everywhere, not just CI. The e2e suite shares
  // a single seeded user (`test@hashhive.local`) AND shared backend
  // state -- any spec that picks a project on `/select-project` writes
  // `users.last_project_id`, and BetterAuth's session.create.before
  // hook rehydrates `session.projectId` from that column on the next
  // sign-in. With multiple workers, cross-file races produce
  // intermittent "land on / instead of /select-project" timeouts that
  // are invisible in CI's single-worker run. Until each spec has an
  // isolated seeded user OR `last_project_id` is reset between tests,
  // single-worker is the only durable answer. `fullyParallel: true`
  // stays because it's the right default once state isolation is in
  // place; it's a no-op while `workers: 1` is in effect.
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  workers: 1,
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
