import { expect, test } from '@playwright/test'

/**
 * Directory (AD/LDAP) sign-in happy path (U8 of the AD/LDAP authentication
 * plan, docs/plans/2026-07-12-001-feat-adldap-authentication-support-plan.md,
 * R20/R21). Placeholder per KTD9 + this repo's e2e conventions
 * (`project_playwright_e2e_planned`): Playwright's `webServer` here spawns
 * the backend WITHOUT `LDAP_ENABLED` or a directory service (see
 * `packages/frontend/playwright.config.ts`) -- there is no seeded
 * GLAuth/OpenLDAP container wired into the e2e lane the way the backend's
 * `tests/db` lane wires one for KTD9. `GET /api/v1/dashboard/auth/methods`
 * would return `{ local: true, ldap: false }` in this environment, so the
 * "Sign in with Directory" option never renders and this scenario cannot
 * pass as written.
 *
 * `test.skip('title', body)` keeps the intended flow real, runnable
 * Playwright code (drop the `.skip` once an LDAP-enabled e2e environment
 * with seeded directory fixtures exists), rather than a stale comment that
 * silently drifts from the actual login page markup.
 */
test.skip('directory sign-in reveals inline fields and reaches the dashboard', async ({ page }) => {
  const DIRECTORY_USERNAME = 'jdoe'
  const DIRECTORY_PASSWORD = 'directory-password'

  await page.goto('/login')
  await expect(page.locator('h1')).toContainText('HashHive')

  // GET /api/v1/dashboard/auth/methods resolves { ldap: true } in the
  // target environment, so the SSO-style directory option renders.
  const directoryTrigger = page.getByRole('button', { name: 'Sign in with Directory' })
  await expect(directoryTrigger).toBeVisible()
  await expect(directoryTrigger).toHaveAttribute('aria-expanded', 'false')

  await directoryTrigger.click()
  await expect(directoryTrigger).toHaveAttribute('aria-expanded', 'true')

  const usernameField = page.getByLabel('Directory Username')
  await expect(usernameField).toBeVisible()
  await expect(usernameField).toBeFocused()

  await usernameField.fill(DIRECTORY_USERNAME)
  await page.getByLabel('Directory Password').fill(DIRECTORY_PASSWORD)
  await page.getByRole('button', { name: 'Continue with Directory' }).click()

  // A directory user in a mapped group (e.g. hh-operators) reaches the
  // dashboard through the same post-login flow as local sign-in
  // (single-project auto-select, or the /select-project multi-project
  // fork covered by select-project.spec.ts).
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15_000 })
  if (page.url().includes('/select-project')) {
    await page.click('button:has-text("Test Project")')
  }
  await page.waitForURL('/', { timeout: 10_000 })
  await expect(page.locator('aside')).toBeVisible()
})
