import { test } from '@playwright/test'
/**
 * One-shot demo capture for PR #178 (#160).
 *
 * Walks the multi-project select flow and emits one PNG per step into
 * /tmp/demo-reel-160/. Stitched into a GIF by ce-demo-reel; not part of
 * the standard e2e suite. Run via:
 *   bun --filter @hashhive/frontend exec playwright test demo-capture.spec.ts
 */
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const OUT_DIR = '/tmp/demo-reel-160'
const TEST_EMAIL = 'test@hashhive.local'
const TEST_PASSWORD = 'TestPassword123!'

mkdirSync(OUT_DIR, { recursive: true })

const shot = async (page: import('@playwright/test').Page, n: number, name: string) => {
  await page.screenshot({
    path: resolve(OUT_DIR, `${String(n).padStart(2, '0')}-${name}.png`),
    fullPage: false,
  })
}

test('demo: multi-project login → remember-last → dashboard → logout', async ({ page }) => {
  // Wider viewport so the full layout reads in the GIF
  await page.setViewportSize({ width: 1280, height: 800 })

  // 01 — Login page on first visit
  await page.goto('/login')
  await page.waitForSelector('h1:has-text("HashHive")')
  await shot(page, 1, 'login-empty')

  // 02 — Filled credentials, about to submit
  await page.fill('#email', TEST_EMAIL)
  await page.fill('#password', TEST_PASSWORD)
  await shot(page, 2, 'login-filled')

  // 03 — Multi-project selector lands
  await page.click('button[type="submit"]')
  await page.waitForURL('/select-project', { timeout: 15_000 })
  await page.waitForSelector('h1:has-text("Select Project")')
  await shot(page, 3, 'selector-default')

  // 04 — Remember-last checkbox toggled on (the headline #160 affordance)
  await page.click('input[type="checkbox"]#remember-last-project')
  await shot(page, 4, 'selector-remember-on')

  // 05 — Dashboard after selecting a project
  await page.click('button:has-text("Test Project")')
  await page.waitForURL('/', { timeout: 10_000 })
  await page.waitForSelector('aside')
  await shot(page, 5, 'dashboard')

  // 06 — Sidebar zoomed-ish (full viewport but with sidebar focus implicit)
  await page.hover('aside')
  await shot(page, 6, 'sidebar-visible')

  // 07 — Sign out → /login
  await page.click('button:has-text("Sign out")')
  await page.waitForURL('/login', { timeout: 10_000 })
  await page.waitForSelector('#email')
  await shot(page, 7, 'logout-back-to-login')
})
