import { expect, type Page, test } from '@playwright/test'

const TEST_EMAIL = 'test@hashhive.local'
const TEST_PASSWORD = 'TestPassword123!'

// Empty-state copy emitted by ResultsTable when no cracked results are
// returned. The e2e seed (e2e/setup/seed-data.ts) provisions a user, two
// projects, one offline agent, and one running campaign (with a hash list) —
// but no cracked results.
// The spec must tolerate this baseline and skip download-related assertions
// when the table is empty.
const RESULTS_EMPTY_COPY = 'No cracks in the current filter.'

/**
 * Shared login + project-select prelude. Mirrors the pattern in
 * zz-dashboard.spec.ts: a multi-project user might land on /select-project
 * first, but the BetterAuth session.create.before hook can rehydrate
 * users.last_project_id and skip the selector on subsequent runs. Tolerate
 * either path.
 */
async function loginAndSelectProject(page: Page): Promise<void> {
  await page.goto('/login')
  await page.fill('#email', TEST_EMAIL)
  await page.fill('#password', TEST_PASSWORD)
  await page.click('button[type="submit"]')

  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15_000 })
  if (page.url().includes('/select-project')) {
    await page.click('button:has-text("Test Project")')
  }
  await page.waitForURL('/', { timeout: 10_000 })
}

test.describe.serial('Results flow E2E (U11)', () => {
  test.beforeEach(async ({ page }) => {
    await loginAndSelectProject(page)
  })

  test('global /results page: mount -> filter -> search -> export', async ({ page }) => {
    // Use sidebar navigation (the smoke spec pattern) rather than page.goto.
    // A direct goto immediately after the post-login waitForURL('/') can race
    // with the project-selection rehydration in useUiStore and snapshot the
    // dashboard instead of /results.
    await expect(page.locator('aside')).toBeVisible()
    await page.click('a[href="/results"]')
    await page.waitForURL('/results', { timeout: 10_000 })

    // PageHeader is the canonical mount marker.
    await expect(page.getByRole('heading', { name: 'Cracked Results' })).toBeVisible()

    // ResultsTable now renders null during initial load and the parent
    // page chrome (LiveIndicator, filters) carries the affordance. Wait
    // for the LiveIndicator label to render — it always mounts once the
    // page itself paints.
    await expect(page.getByText('Live').first()).toBeVisible({ timeout: 15_000 })

    // The campaign filter is a Radix Select (combobox), not a native <select>.
    // Open it; the first listbox option is the "all campaigns" placeholder, so
    // a real campaign exists only when there is more than one option. Pick the
    // first real one and assert the URL gains a numeric campaignId — selecting
    // the placeholder would not, so the assertion is self-validating.
    const campaignSelect = page.getByLabel('Filter by campaign')
    await expect(campaignSelect).toBeVisible()
    await campaignSelect.click()

    // Wait for the portaled listbox to mount before counting — count() is
    // immediate and would otherwise read 0 mid-mount and skip the real
    // selection assertion even when campaigns exist.
    const listbox = page.getByRole('listbox')
    await expect(listbox).toBeVisible()
    const campaignOptions = listbox.getByRole('option')
    const optionCount = await campaignOptions.count()
    if (optionCount > 1) {
      await campaignOptions.nth(1).click()
      await page.waitForURL((url) => /campaignId=\d+/.test(url.search), {
        timeout: 5_000,
      })

      // Clear back to "all campaigns" via the placeholder option — exercises the
      // Select EMPTY_SENTINEL reverse path (onValueChange '__NONE__' -> '') so a
      // broken sentinel round-trip would leave campaignId stuck in the URL.
      await campaignSelect.click()
      await expect(page.getByRole('listbox')).toBeVisible()
      await campaignOptions.nth(0).click()
      await page.waitForURL((url) => !url.search.includes('campaignId='), {
        timeout: 5_000,
      })
    } else {
      // No real campaigns to pick; close the listbox and continue.
      await page.keyboard.press('Escape')
    }

    // Search input write -> debounced URL update (debounce ~300ms inside
    // ResultsFilters). The debounce only fires onFiltersChange when the value
    // differs from the parent's filter, so a non-empty unique string is safe.
    const searchInput = page.getByLabel('Search hashes or plaintexts')
    await searchInput.fill('abc')
    await page.waitForURL((url) => url.search.includes('q=abc'), { timeout: 5_000 })

    // Empty-state branch: if the table reports "No cracked results found." the
    // export endpoint will still return a (zero-row) CSV, but it's the empty
    // state assertion that's the contract here. Production fixtures often have
    // no cracked rows, so we tolerate that and stop before clicking Export to
    // keep the spec deterministic on a fresh DB.
    const emptyState = page.getByText(RESULTS_EMPTY_COPY)
    const rowCount = await page.locator('tbody tr').count()
    if (rowCount === 0) {
      await expect(emptyState).toBeVisible()
      return
    }

    // Populated path: click Export CSV and observe the download event. The
    // export hook composes the filename from Content-Disposition or falls
    // back to `results-{projectId}-{ISO}.csv`. Both shapes match /results-.*\.csv/i.
    const exportButton = page.getByRole('button', { name: /Export CSV/i })
    await expect(exportButton).toBeEnabled()

    const downloadPromise = page.waitForEvent('download', { timeout: 10_000 })
    await exportButton.click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toMatch(/results-.*\.csv$/i)
  })

  test('campaign detail Results tab: switch tab -> observe stats card', async ({ page }) => {
    // Sidebar navigation (smoke spec pattern) avoids the goto-vs-project-rehydrate
    // race that bites direct page.goto right after the post-login waitForURL.
    await expect(page.locator('aside')).toBeVisible()
    await page.click('a[href="/campaigns"]')
    await page.waitForURL('/campaigns', { timeout: 10_000 })
    await expect(page.getByRole('heading', { name: /Campaigns/i }).first()).toBeVisible()

    // Find the first campaign row link, if any. The seed fixture provisions
    // no campaigns — on a fresh DB this scenario is a deterministic skip
    // rather than a flaky failure.
    const campaignLink = page.locator('a[href^="/campaigns/"]').first()
    const campaignLinkCount = await page.locator('a[href^="/campaigns/"]').count()
    if (campaignLinkCount === 0) {
      test.skip(true, 'No campaigns seeded in this environment')
      return
    }

    const href = await campaignLink.getAttribute('href')
    if (!href || href === '/campaigns/new') {
      test.skip(true, 'Only the "New campaign" link is present; no real campaigns to visit')
      return
    }

    await campaignLink.click()
    // Escape ALL regex metacharacters in `href` before composing the
    // wait pattern. Only escaping `/` (the previous approach) would
    // leave other metacharacters (`?`, `.`, `(`, `)`, etc.) live in
    // the regex, which is what CodeQL flagged.
    const safeHref = href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    await page.waitForURL(new RegExp(`${safeHref}(\\?.*)?$`), { timeout: 10_000 })

    // Switch to the Results tab via the role=tab affordance (Tabs.Trigger
    // renders role="tab"). The Tabs primitive writes the URL param on the
    // call site's handleTabChange, so ?tab=results is observable.
    await page.getByRole('tab', { name: 'Results' }).click()
    await page.waitForURL((url) => url.search.includes('tab=results'), { timeout: 5_000 })

    // Inline stats render in the Results tab header, even when
    // totalCracked=0. The data-testid is the most stable hook.
    await expect(page.getByTestId('results-stats')).toBeVisible()
    await expect(page.getByTestId('results-stats')).toContainText(/Cracked/i)
  })
})
