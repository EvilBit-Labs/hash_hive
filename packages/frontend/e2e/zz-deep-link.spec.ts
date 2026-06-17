import { expect, test } from '@playwright/test'

const TEST_EMAIL = 'test@hashhive.local'
const TEST_PASSWORD = 'TestPassword123!'

// Regression for issue #227: a hard load / refresh of a dashboard sub-route
// must stay on that route, not redirect to the dashboard (`/`). The bug was
// ProtectedRoute deciding "no project -> redirect" before fetchProjects()
// resolved on a cold load, discarding the requested route.
//
// `zz-` prefix runs this spec late so it does not write `users.last_project_id`
// ahead of the multi-project selector test in select-project.spec.ts (which
// needs a clean column to route through the selector). Combined with the
// config's `workers: 1`, this keeps the shared seed user's state deterministic.
// See docs/solutions/test-failures/playwright-shared-seed-user-last-project-id-flake.md.
test.describe('Deep-link and refresh on sub-routes (issue #227)', () => {
  test('direct navigation and reload of a sub-route stay on that route', async ({ page }) => {
    // Sign in and ensure a project is selected, so the server session carries
    // projectId -- the state a real operator's deep link / refresh runs against.
    await page.goto('/login')
    await page.fill('#email', TEST_EMAIL)
    await page.fill('#password', TEST_PASSWORD)
    await page.click('button[type="submit"]')

    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15_000 })
    if (page.url().includes('/select-project')) {
      await page.click('button:has-text("Test Project")')
    }
    await page.waitForURL('/', { timeout: 10_000 })

    // Deep link: a hard navigation to a sub-route stays on that sub-route. The
    // heading assertion (auto-retried) waits out hydration -- a buggy redirect
    // to `/` would render the "Dashboard" heading instead of "Campaigns".
    await page.goto('/campaigns')
    await expect(page.getByRole('heading', { level: 1, name: 'Campaigns' })).toBeVisible()
    await expect(page).toHaveURL('/campaigns')

    // Refresh: reloading a sub-route stays on that sub-route.
    await page.goto('/agents')
    await expect(page.getByRole('heading', { level: 1, name: 'Agents' })).toBeVisible()
    await page.reload()
    await expect(page.getByRole('heading', { level: 1, name: 'Agents' })).toBeVisible()
    await expect(page).toHaveURL('/agents')
  })
})
