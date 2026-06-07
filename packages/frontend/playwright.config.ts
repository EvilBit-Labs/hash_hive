import { defineConfig, devices } from '@playwright/test'

// E2E runs on a distinct port lane from `just dev` (3000 / 4000) so a
// developer can leave the dev backend running and still get clean
// runs. `VITE_API_PROXY_TARGET` makes the Vite dev server proxy to the
// E2E backend instead of the dev one; `PORT` keeps the E2E frontend
// off the dev frontend's port. global-setup binds the spawned test
// backend to E2E_BACKEND_PORT.
const E2E_FRONTEND_PORT = process.env['E2E_FRONTEND_PORT'] ?? '3400'
const E2E_BACKEND_PORT = process.env['E2E_BACKEND_PORT'] ?? '4400'
const E2E_BASE_URL = `http://localhost:${E2E_FRONTEND_PORT}`
const E2E_BACKEND_URL = `http://localhost:${E2E_BACKEND_PORT}`

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
    baseURL: E2E_BASE_URL,
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
    url: E2E_BASE_URL,
    // `env` propagates to the spawned Vite process so its config picks
    // up the E2E port + proxy target. global-setup likewise spawns the
    // backend on E2E_BACKEND_PORT. reuseExistingServer is fine in
    // local mode — nothing else normally listens on 3400.
    env: {
      PORT: E2E_FRONTEND_PORT,
      VITE_API_PROXY_TARGET: E2E_BACKEND_URL,
    },
    reuseExistingServer: !process.env['CI'],
  },
})
