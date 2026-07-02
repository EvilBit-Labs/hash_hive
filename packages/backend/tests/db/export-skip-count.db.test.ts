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

import { campaigns, hashItems, hashLists, projects } from '@hashhive/shared'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { and, eq } from 'drizzle-orm'

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

// ─── q filter restricts exported rows ────────────────────────────────────────

describe('createExport: q filter restricts exported rows', () => {
  it('cracked-pairs CSV export returns only rows matching q (hashValue ILIKE)', async () => {
    // Seed data contains 'deadbeef00', 'deadbeef01', 'deadbeef02'.
    // q='deadbeef00' matches exactly the first item (no plaintext contains this term).
    const { skippedCount, rows } = await createExport(db, {
      scope: 'project',
      projectId,
      variant: 'cracked-pairs',
      format: 'csv',
      filters: { q: 'deadbeef00' },
    })

    const lines: string[] = []
    for await (const line of rows) {
      lines.push(line)
    }

    expect(skippedCount).toBe(0) // CSV never skips
    // Header line + exactly 1 data row for the matching hash item
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('deadbeef00')
    expect(lines[1]).not.toContain('deadbeef01')
    expect(lines[1]).not.toContain('deadbeef02')
  })

  it('q filter with no matches returns only the CSV header', async () => {
    const { skippedCount, rows } = await createExport(db, {
      scope: 'project',
      projectId,
      variant: 'cracked-pairs',
      format: 'csv',
      filters: { q: 'xyzzy-no-match' },
    })

    const lines: string[] = []
    for await (const line of rows) {
      lines.push(line)
    }

    expect(skippedCount).toBe(0)
    expect(lines).toHaveLength(1) // header only
  })
})

// ─── (new) test 8: campaign-scope export skips correctly ─────────────────────

describe('createExport: campaign-scope skip count', () => {
  it('skips cracked items belonging to a campaign when the list has no hash type (potfile)', async () => {
    // Seed a campaign linked to the existing no-hash-type list
    const [camp] = await db
      .insert(campaigns)
      .values({
        name: 'export-skip-camp-v8',
        projectId,
        hashListId: listId,
        priority: 1,
        status: 'running',
      })
      .returning({ id: campaigns.id })
    const campId = camp!.id

    const now = new Date()
    const CAMP_ITEM_COUNT = 2
    await db.insert(hashItems).values([
      {
        hashListId: listId,
        hashValue: 'camp-skip-hash-a-v8',
        plaintext: 'passA',
        crackedAt: new Date(now.getTime() + 10_000),
        campaignId: campId,
      },
      {
        hashListId: listId,
        hashValue: 'camp-skip-hash-b-v8',
        plaintext: 'passB',
        crackedAt: new Date(now.getTime() + 11_000),
        campaignId: campId,
      },
    ])

    try {
      const { skippedCount, rows } = await createExport(db, {
        scope: 'campaign',
        projectId,
        campaignId: campId,
        variant: 'cracked-pairs',
        format: 'hashcat-potfile',
      })

      for await (const _line of rows) {
        /* drain */
      }

      // All items skipped because the list has no hash type (hashcatMode null)
      expect(skippedCount).toBe(CAMP_ITEM_COUNT)
    } finally {
      await db
        .delete(hashItems)
        .where(and(eq(hashItems.hashListId, listId), eq(hashItems.campaignId, campId)))
      await db.delete(campaigns).where(eq(campaigns.id, campId))
    }
  })
})
