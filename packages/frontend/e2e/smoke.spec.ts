import { expect, test } from '@playwright/test'

const TEST_EMAIL = 'test@hashhive.local'
const TEST_PASSWORD = 'TestPassword123!'

test.describe('E2E Smoke Suite', () => {
  test('login -> select project -> navigate core pages', async ({ page }) => {
    // 1. Navigate to login page
    await page.goto('/login')
    await expect(page.locator('h1')).toContainText('HashHive')

    // 2. Fill login form with seeded credentials
    await page.fill('#email', TEST_EMAIL)
    await page.fill('#password', TEST_PASSWORD)
    await page.click('button[type="submit"]')

    // 3. Wait for redirect -- BetterAuth's useSession() reactively updates after
    //    signIn.email() sets the cookie. Single-project user auto-selects project.
    //    Wait for URL to leave /login (could briefly hit /select-project first).
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15_000 })

    // If we landed on /select-project, click the project to proceed
    if (page.url().includes('/select-project')) {
      await page.click('button:has-text("Test Project")')
    }
    await page.waitForURL('/', { timeout: 10_000 })

    // 4. Verify dashboard loads (root path is the dashboard)
    await expect(page.locator('aside')).toBeVisible()

    // 5. Navigate to Campaigns page via sidebar
    await page.click('a[href="/campaigns"]')
    await page.waitForURL('/campaigns')
    await expect(page).toHaveURL('/campaigns')

    // 6. Navigate to Agents page
    await page.click('a[href="/agents"]')
    await page.waitForURL('/agents')
    await expect(page).toHaveURL('/agents')

    // 7. Navigate to Resources page
    await page.click('a[href="/resources"]')
    await page.waitForURL('/resources')
    await expect(page).toHaveURL('/resources')

    // 8. Navigate to Results page
    await page.click('a[href="/results"]')
    await page.waitForURL('/results')
    await expect(page).toHaveURL('/results')

    // 9. Navigate back to Dashboard
    await page.click('a[href="/"]')
    await page.waitForURL('/')
    await expect(page).toHaveURL('/')
  })

  test('invalid credentials show error', async ({ page }) => {
    await page.goto('/login')

    await page.fill('#email', 'wrong@example.com')
    await page.fill('#password', 'WrongPassword123!')
    await page.click('button[type="submit"]')

    // Should stay on login page and show error
    await expect(page).toHaveURL('/login')
    await expect(page.locator('.bg-destructive\\/10')).toBeVisible({ timeout: 5_000 })
  })

  test('unauthenticated access redirects to login', async ({ page }) => {
    // Accessing a protected route without auth should redirect to login
    await page.goto('/campaigns')
    await expect(page).toHaveURL('/login')
  })
})
