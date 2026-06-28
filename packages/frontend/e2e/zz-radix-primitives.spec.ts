import { expect, type Page, test } from '@playwright/test'

import { TEST_CAMPAIGN, TEST_HASH_LIST } from './setup/seed-data'

const TEST_EMAIL = 'test@hashhive.local'
const TEST_PASSWORD = 'TestPassword123!'

/**
 * Exercises the Radix-backed primitives introduced by the shadcn migration on
 * the interaction paths happy-dom cannot drive: Select portal open + keyboard
 * selection, Dialog focus-trap + Escape, ToggleGroup roving keyboard nav, and
 * Tabs arrow-key activation. These are the R5 "routed to Playwright" cases.
 */

async function login(page: Page): Promise<void> {
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

async function openSeededCampaign(page: Page): Promise<void> {
  await page.click('a[href="/campaigns"]')
  await page.waitForURL('/campaigns')
  await page.getByText(TEST_CAMPAIGN.name).first().click()
  await page.waitForURL(/\/campaigns\/\d+/, { timeout: 10_000 })
}

test.describe('Radix primitives (shadcn migration)', () => {
  test('Select: opens a portal listbox and selects an option by click and by keyboard', async ({
    page,
  }) => {
    await login(page)
    await page.click('a[href="/results"]')
    await page.waitForURL('/results')

    const dateRange = page.getByRole('combobox', { name: 'Filter by date range' })
    await expect(dateRange).toBeVisible()
    await expect(dateRange).toContainText('Last 30 days')

    // Click-open: the portaled listbox renders (happy-dom cannot mount it).
    await dateRange.click()
    await expect(page.getByRole('listbox')).toBeVisible()
    await page.getByRole('option', { name: 'Last 7 days' }).click()
    await expect(dateRange).toContainText('Last 7 days')

    // Keyboard-open + keyboard-select: focus the trigger, open with Enter,
    // move the highlight, and commit with Enter.
    await dateRange.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('listbox')).toBeVisible()
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('listbox')).toBeHidden()
    await expect(dateRange).toContainText(/Last|All time/)
  })

  test('Dialog: traps focus inside the overlay and Escape dismisses it', async ({ page }) => {
    await login(page)
    await openSeededCampaign(page)

    // The seeded campaign is "running", so the Stop action is available. Escape
    // cancels the confirmation, so this never actually stops the campaign.
    const stopTrigger = page.getByRole('button', { name: 'Stop' })
    await expect(stopTrigger).toBeVisible()
    await stopTrigger.click()

    const dialog = page.getByRole('dialog', { name: /Stop campaign/i })
    await expect(dialog).toBeVisible()

    // Focus is trapped inside the dialog (Radix focus-scope) and stays inside
    // across a Tab — the hand-rolled div this replaced did neither.
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true)
    await page.keyboard.press('Tab')
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true)

    // Escape dismisses the dialog (Radix dismissable-layer) — the hand-rolled
    // div this replaced had no Escape handling.
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  })

  test('ToggleGroup: arrow keys move roving focus, selection stays mandatory', async ({ page }) => {
    await login(page)
    await page.goto('/resources')

    // The Hash Lists tab may need activating before the seeded list link shows.
    const hashListsTab = page
      .getByRole('tab', { name: /Hash Lists/i })
      .or(page.getByRole('button', { name: /Hash Lists/i }))
    if (
      await hashListsTab
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      await hashListsTab.first().click()
    }
    await page.getByRole('link', { name: TEST_HASH_LIST.name }).first().click()
    await page.waitForURL(/\/resources\/hash-lists\/\d+/, { timeout: 10_000 })

    const group = page.getByRole('radiogroup', { name: 'Hash list view' })
    await expect(group).toBeVisible()
    const all = page.getByRole('radio', { name: 'All', exact: true })
    const cracked = page.getByRole('radio', { name: 'Cracked', exact: true })

    await all.click()
    await expect(all).toBeChecked()

    // Roving keyboard nav: ArrowRight moves into the next segment.
    await all.focus()
    await page.keyboard.press('ArrowRight')
    await expect(cracked).toBeFocused()

    // Selection stays mandatory: exactly one segment is always checked.
    await expect(group.getByRole('radio', { checked: true })).toHaveCount(1)
  })

  test('Tabs: arrow keys move the active tab on campaign detail', async ({ page }) => {
    await login(page)
    await openSeededCampaign(page)

    const tabs = page.getByRole('tab')
    await expect(tabs.first()).toBeVisible()
    const first = tabs.nth(0)
    const second = tabs.nth(1)

    await first.click()
    await expect(first).toHaveAttribute('aria-selected', 'true')

    // Radix Tabs default automatic activation: ArrowRight focuses and activates
    // the next tab in one step.
    await first.focus()
    await page.keyboard.press('ArrowRight')
    await expect(second).toHaveAttribute('aria-selected', 'true')
    await expect(first).toHaveAttribute('aria-selected', 'false')
  })
})
