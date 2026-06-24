import { expect, test } from '@playwright/test'

const TEST_EMAIL = 'test@hashhive.local'
const TEST_PASSWORD = 'TestPassword123!'

// 1440x900 is the canonical operator desktop viewport for the dashboard
// delight-pass (issue #162). Set per-file to override Playwright's default
// 1280x720 "Desktop Chrome" projects entry without forking a new project.
test.use({ viewport: { width: 1440, height: 900 } })

// Filename prefix `zz-` puts this spec last in the alphabetical run order so
// it does not corrupt the `last_project_id` state that `select-project.spec.ts`
// asserts against earlier in the same `workers: 1` session. The flake is
// documented in `docs/solutions/test-failures/playwright-shared-seed-user-last-project-id-flake.md`.
//
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

    // ConnectionIndicator currently renders in three places on `/`: the app
    // layout (`components/features/layout.tsx`), the sidebar
    // (`components/features/sidebar.tsx`), and the dashboard header itself
    // (`pages/dashboard.tsx`). Each emits an `<output aria-label="...">`
    // with one of the four status labels. We assert the expected count of 3
    // so any future consolidation lands as an intentional test update,
    // rather than a surprise.
    const indicators = page.locator('output[aria-label]').filter({
      hasText: /Live|Polling|Reconnecting|Disconnected/i,
    })
    await expect(indicators).toHaveCount(3)
  })

  test('sparkline gradient ids are unique across the four stat cards', async ({ page }) => {
    // happy-dom can't reliably expose SVG `<defs>` to querySelector, so the
    // unit suite punts on this assertion. The browser test is the canonical
    // check that `useId()`-derived gradient ids do not collide and each
    // sparkline references its own gradient via `fill="url(#stat-spark-...)"`.
    await expect(page.locator('[data-testid="stat-card"]')).toHaveCount(4)

    // Collect gradient ids declared in the four stat-card sparklines and
    // verify each card has a distinct id. If two cards collided, recharts
    // would render the same gradient fill in both and one would visually
    // wrong-color silently.
    const gradientIds = await page
      .locator('linearGradient[id^="stat-spark-"]')
      .evaluateAll((els) => els.map((el) => el.id))
    // Each card renders one sparkline gradient (skipped when sparkData < 2);
    // assert no duplicates among whatever rendered.
    expect(new Set(gradientIds).size).toBe(gradientIds.length)
  })

  test('Cracked card uses hero text-5xl prominence', async ({ page }) => {
    const cards = page.locator('[data-testid="stat-card"]')
    await expect(cards).toHaveCount(4)

    // Cracked is the first card in the bento (top-left of the 12-col grid,
    // col-span-5) and uses text-5xl as the hero metric per the bolder pass
    // — see StatCard primary emphasis. Supporting cards use text-2xl.
    const crackedValue = cards.nth(0).locator('span.text-5xl').first()
    await expect(crackedValue).toBeVisible()
  })

  // Visual baseline: skipped until the Linux baseline PNG is committed.
  // The baseline is CI-Linux-canonical (pinned ubuntu-24.04). Generate it via
  // the `regenerate-visual-baselines.yml` workflow (label a PR with
  // `regen-baselines`, or `workflow_dispatch` once it's on main), download the
  // artifact, commit the PNG, and unskip this test in the same commit. Local
  // macOS runs WILL diff on font rendering and must NOT update the baseline —
  // that mismatch message is expected, not a regression. Full procedure:
  // docs/solutions/conventions/playwright-visual-baselines.md.
  //
  // Determinism (why this differs from a plain toHaveScreenshot):
  //  - We wait for the `Live` (open) connection state before capturing. That
  //    unmounts the conditional FreshnessLine ("Last updated X ago", a 1Hz
  //    wall-clock ticker rendered as <p data-testid="dashboard-last-updated">),
  //    which would otherwise reflow the bento grid and is NOT covered by the
  //    output[aria-label] mask. It also fixes the indicator label width.
  //  - `prefers-reduced-motion: reduce` resolves motion/react to its end state
  //    (animations:'disabled' only fast-forwards CSS, not JS/rAF motion).
  //  - The mask is belt-and-suspenders over any residual WS-status pixels;
  //    masked regions render as magenta boxes in the committed PNG (expected).
  //  - retries:0 (configured on this nested describe) makes the no-op re-run a
  //    strict idempotency check; the file default is retries:2 in CI.
  test.describe('visual baseline', () => {
    test.describe.configure({ retries: 0 })

    test.skip('dashboard visual baseline at 1440x900', async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' })

      // Drive to a single deterministic connection state: on `open` the
      // indicators read "Live" and FreshnessLine does not mount.
      await expect(page.locator('output[aria-label="Live"]').first()).toBeVisible()

      await expect(page.locator('[data-testid="stat-card"]')).toHaveCount(4)
      await expect(page.getByRole('region', { name: /crack rate trend/i })).toBeVisible()

      await expect(page).toHaveScreenshot('dashboard-1440x900.png', {
        maxDiffPixelRatio: 0.02,
        fullPage: false,
        animations: 'disabled',
        mask: [page.locator('output[aria-label]')],
      })
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

    // Deterministic R9 assertion: every `.animate-ping` element on the page
    // MUST carry the `motion-reduce:animate-none` gate. We do not assert the
    // ping exists (WS state is non-deterministic in CI), but we DO assert
    // that an ungated ping never appears — if one shows up, the page is
    // animating under prefers-reduced-motion: reduce. Empty count is a pass
    // (no pings = no R9 violation); any non-zero count of ungated pings is
    // a hard fail.
    const ungatedPings = page.locator('.animate-ping:not(.motion-reduce\\:animate-none)')
    await expect(ungatedPings).toHaveCount(0)
  })
})
