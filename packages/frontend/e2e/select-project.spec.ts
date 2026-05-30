import { expect, test } from '@playwright/test'

const TEST_EMAIL = 'test@hashhive.local'
const TEST_PASSWORD = 'TestPassword123!'

// `serial` is the in-file half of the state-isolation answer: both tests
// sign in as `test@hashhive.local`, and the sign-out test picks "Test
// Project" -- which writes `users.last_project_id`. On a subsequent
// sign-in by the same user, the BetterAuth `session.create.before` hook
// rehydrates `session.projectId` from that column, so the multi-project
// test would land on `/` instead of `/select-project` and time out.
// `serial` enforces order within this file; the playwright.config.ts
// `workers: 1` setting handles the cross-file half (smoke.spec.ts also
// mutates `last_project_id` via the same selector flow). Both halves are
// load-bearing until each spec has its own seeded user.
test.describe.serial('Multi-project select flow (issue #160)', () => {
  test('multi-project login routes through selector and POSTs /projects/select', async ({
    page,
  }) => {
    await page.goto('/login')
    await expect(page.locator('h1')).toContainText('HashHive')

    await page.fill('#email', TEST_EMAIL)
    await page.fill('#password', TEST_PASSWORD)

    // Capture the select POST so we can assert it fires from a click on the card.
    const selectRequest = page.waitForRequest(
      (req) => req.url().includes('/api/v1/dashboard/projects/select') && req.method() === 'POST'
    )

    await page.click('button[type="submit"]')

    // Multi-project user lands on the selector
    await page.waitForURL('/select-project', { timeout: 15_000 })
    await expect(page.locator('h1')).toContainText('Select Project')

    // Both seeded projects render
    await expect(page.locator('button:has-text("Test Project")')).toBeVisible()
    await expect(page.locator('button:has-text("Secondary Project")')).toBeVisible()

    await page.click('button:has-text("Test Project")')

    const req = await selectRequest
    expect(req.postDataJSON()).toMatchObject({ projectId: expect.any(Number) })

    await page.waitForURL('/', { timeout: 10_000 })
    await expect(page.locator('aside')).toBeVisible()
  })

  test('sidebar sign-out returns to /login', async ({ page }) => {
    // Log in and pick a project so we're on a protected page
    await page.goto('/login')
    await page.fill('#email', TEST_EMAIL)
    await page.fill('#password', TEST_PASSWORD)
    await page.click('button[type="submit"]')

    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15_000 })
    if (page.url().includes('/select-project')) {
      await page.click('button:has-text("Test Project")')
    }
    await page.waitForURL('/', { timeout: 10_000 })

    // Sign out from the sidebar footer
    await page.click('button:has-text("Sign out")')

    await page.waitForURL('/login', { timeout: 10_000 })
    await expect(page.locator('#email')).toBeVisible()
  })
})
