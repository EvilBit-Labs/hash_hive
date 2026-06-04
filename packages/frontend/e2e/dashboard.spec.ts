import { expect, test } from '@playwright/test'

const TEST_EMAIL = 'test@hashhive.local'
const TEST_PASSWORD = 'TestPassword123!'

// 1440x900 is the canonical operator desktop viewport for the dashboard
// delight-pass (issue #162). Set per-file to override Playwright's default
// 1280x720 "Desktop Chrome" projects entry without forking a new project.
test.use({ viewport: { width: 1440, height: 900 } })

// Screenshot baselines are CI-Linux-canonical. macOS-local runs will
// diff on font rendering — use `--update-snapshots` only when adjusting
// the baseline intentionally, never to silence drift.
//
// State-isolation note: the shared seed user `test@hashhive.local` is
// also signed in by select-project.spec.ts and smoke.spec.ts, which
// write `users.last_project_id`. On a subsequent login the BetterAuth
// `session.create.before` hook rehydrates from that column, so the
// router can land on `/` directly. Both flows below tolerate either
// `/select-project` or `/` as the post-login destination.
test.describe.serial('Dashboard delight pass (issue #162)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login')
    await page.fill('#email', TEST_EMAIL)
    await page.fill('#password', TEST_PASSWORD)
    await page.click('button[type="submit"]')

    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15_000 })
    if (page.url().includes('/select-project')) {
      await page.click('button:has-text("Test Project")')
    }
    await page.waitForURL('/', { timeout: 10_000 })
  })

  test('renders four stat cards, crack-rate region, and connection indicator', async ({ page }) => {
    const cards = page.locator('[data-testid="stat-card"]')
    await expect(cards).toHaveCount(4)

    // Each card carries its title in the rendered output
    await expect(page.getByText(/Agents/i).first()).toBeVisible()
    await expect(page.getByText(/Campaigns/i).first()).toBeVisible()
    await expect(page.getByText(/Tasks/i).first()).toBeVisible()
    await expect(page.getByText(/Cracked/i).first()).toBeVisible()

    // Crack-rate region (R16) — section with accessible name "Crack rate trend"
    await expect(page.getByRole('region', { name: /crack rate trend/i })).toBeVisible()

    // Connection indicator renders one of the four buckets
    await expect(page.locator('output')).toHaveCount(1)
  })

  test('Cracked card uses text-3xl prominence (R13)', async ({ page }) => {
    const cards = page.locator('[data-testid="stat-card"]')
    await expect(cards).toHaveCount(4)

    // The fourth card is Cracked (per dashboard.tsx render order) and uses
    // text-3xl; the other three use text-2xl.
    const crackedValue = cards.nth(3).locator('span.text-3xl').first()
    await expect(crackedValue).toBeVisible()
  })

  // Visual baseline: skipped until the Linux baseline PNG is committed.
  // Generate the baseline by running this spec once in CI with
  // `--update-snapshots`, commit the generated `*-snapshots/*.png`, then
  // remove this skip. Local macOS runs will diff on font rendering and
  // must NOT update the baseline — CI Linux rendering is canonical.
  test.skip('dashboard visual baseline at 1440x900', async ({ page }) => {
    // Wait for the page to settle: all four cards present, crack-rate region
    // mounted. Sparklines will be empty on cold load (1 sample) — by design.
    await expect(page.locator('[data-testid="stat-card"]')).toHaveCount(4)
    await expect(page.getByRole('region', { name: /crack rate trend/i })).toBeVisible()

    // Allow a brief settle so motion-cross-fade and any layout reflow finish.
    await page.waitForTimeout(500)

    await expect(page).toHaveScreenshot('dashboard-1440x900.png', {
      maxDiffPixelRatio: 0.02,
      fullPage: false,
      animations: 'disabled',
    })
  })

  test('respects prefers-reduced-motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.reload()
    if (page.url().includes('/select-project')) {
      await page.click('button:has-text("Test Project")')
      await page.waitForURL('/', { timeout: 10_000 })
    }

    await expect(page.locator('[data-testid="stat-card"]')).toHaveCount(4)

    // The animate-ping ping span on the connection indicator must carry the
    // motion-reduce gate so it does not animate under reduce.
    const ping = page.locator('.animate-ping').first()
    const isVisible = await ping.isVisible().catch(() => false)
    if (isVisible) {
      const cls = await ping.getAttribute('class')
      expect(cls).toContain('motion-reduce:animate-none')
    }
  })
})
