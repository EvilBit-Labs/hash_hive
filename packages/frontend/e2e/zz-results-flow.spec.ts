import { expect, type Page, test } from '@playwright/test'

const TEST_EMAIL = 'test@hashhive.local'
const TEST_PASSWORD = 'TestPassword123!'

// Empty-state copy emitted by ResultsTable when no cracked results are
// returned. The dev seed (e2e/setup/seed-data.ts) provisions a user, two
// projects, and one offline agent — no campaigns and no cracked results.
// The spec must tolerate this baseline and skip download-related assertions
// when the table is empty.
const RESULTS_EMPTY_COPY = 'No cracked results found.'

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

    // Wait for the loading affordance to clear so we can branch on the
    // empty-state vs. populated-table assertion below. Either text resolves
    // the wait — the table swaps "Loading results..." for either "No cracked
    // results found." or actual <tr> rows once useResults settles.
    await expect(page.getByText(/Loading results\.\.\./i)).toHaveCount(0, { timeout: 15_000 })

    // The campaign filter is a native <select>. Read its options; only assert
    // the URL-update behavior when there is at least one real campaign to pick.
    const campaignSelect = page.getByLabel('Filter by campaign')
    await expect(campaignSelect).toBeVisible()

    const campaignOptionValues = await campaignSelect
      .locator('option')
      .evaluateAll((opts) => (opts as HTMLOptionElement[]).map((o) => o.value))
    const realCampaignValues = campaignOptionValues.filter((v) => v !== '')
    if (realCampaignValues.length > 0) {
      const targetId = realCampaignValues[0] as string
      await campaignSelect.selectOption(targetId)
      await page.waitForURL((url) => url.search.includes(`campaignId=${targetId}`), {
        timeout: 5_000,
      })
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
    await page.waitForURL(new RegExp(`${href.replace(/\//g, '\\/')}(\\?.*)?$`), { timeout: 10_000 })

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
