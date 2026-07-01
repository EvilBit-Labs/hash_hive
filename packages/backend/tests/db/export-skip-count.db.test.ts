/**
 * Real-DB test for the export skip counter (issue #102, unit U4).
 *
 * Verifies that `createExport` correctly counts skipped rows via the DEFAULT
 * `createDefaultSkippedCounter` (no override injected). The U3 unit tests
 * already cover the skip counter with an injected override; this test exercises
 * the actual Drizzle query path so regressions in the SQL surface here.
 *
 * Scenario:
 *   - Hash list with NO hash type (hashTypeId = null)
 *   - N cracked hash items inserted into the list
 *   - Export with format=hashcat-potfile → each cracked item is skipped because
 *     the list has no associated hash type (hashcatMode is null)
 *   - Assert skippedCount === N (exact count, not just > 0)
 *
 * Runs under `just test-db` (preload: tests/preload-db.ts). Uses the shared
 * drizzle client from `../../src/db/index.js`.
 *
 * NOTE: Do NOT call client.end() — the pooled client is a process-wide
 * singleton shared by every file in the lane.
 * NOTE: Do NOT self-skip — the test-db lane always has Postgres available.
 */

import { hashItems, hashLists, projects } from '@hashhive/shared'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'

import { db } from '../../src/db/index.js'
import { createExport } from '../../src/services/results/export.js'

// ─── Slugs & IDs ─────────────────────────────────────────────────────────────

// Unique slug prevents collision with other parallel DB tests.
const SLUG = 'export-skip-count-test'

let projectId: number
let listId: number

// Number of cracked items to seed — must be > 1 so we verify count, not bool.
const CRACKED_ITEM_COUNT = 3

// ─── Seed helpers ────────────────────────────────────────────────────────────

async function cleanup(): Promise<void> {
  // Cascades delete hash_lists → hash_items via FK constraint.
  await db.delete(projects).where(eq(projects.slug, SLUG))
}

// ─── Test lifecycle ──────────────────────────────────────────────────────────

beforeAll(async () => {
  await cleanup()

  const [proj] = await db
    .insert(projects)
    .values({ name: SLUG, slug: SLUG })
    .returning({ id: projects.id })
  projectId = proj!.id

  // hashTypeId intentionally null — drives skip-count path in the exporter.
  const [list] = await db
    .insert(hashLists)
    .values({ projectId, name: 'test-list', status: 'ready', hashTypeId: null })
    .returning({ id: hashLists.id })
  listId = list!.id

  // Insert CRACKED_ITEM_COUNT cracked hash items (crackedAt IS NOT NULL).
  const now = new Date()
  await db.insert(hashItems).values(
    Array.from({ length: CRACKED_ITEM_COUNT }, (_, i) => ({
      hashListId: listId,
      hashValue: `deadbeef0${i}`,
      plaintext: `password${i}`,
      crackedAt: new Date(now.getTime() + i * 1000),
    }))
  )
})

afterAll(async () => {
  await cleanup()
})

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('createExport: skip count via default SQL counter', () => {
  it('skips all cracked rows when the hash list has no hash type (hashcat-potfile)', async () => {
    const { skippedCount, rows } = await createExport(db, {
      scope: 'project',
      projectId,
      variant: 'cracked-pairs',
      format: 'hashcat-potfile',
      // No overrides — exercises createDefaultSkippedCounter directly.
    })

    // Drain the generator so any errors in the row fetcher surface here too.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _line of rows) {
      /* drain */
    }

    expect(skippedCount).toBe(CRACKED_ITEM_COUNT)
  })

  it('skippedCount is 0 for CSV format regardless of hash type', async () => {
    const { skippedCount, rows } = await createExport(db, {
      scope: 'project',
      projectId,
      variant: 'cracked-pairs',
      format: 'csv',
    })

    for await (const _line of rows) {
      /* drain */
    }

    expect(skippedCount).toBe(0)
  })

  it('hash-list scope also skips correctly for potfile', async () => {
    const { skippedCount, rows } = await createExport(db, {
      scope: 'hash-list',
      projectId,
      hashListId: listId,
      variant: 'cracked-pairs',
      format: 'hashcat-potfile',
    })

    for await (const _line of rows) {
      /* drain */
    }

    expect(skippedCount).toBe(CRACKED_ITEM_COUNT)
  })
})
