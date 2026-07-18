/**
 * Real-DB tests for `moveHashItemsToList`'s batched UPDATE (issue #202 code
 * review P1 fix).
 *
 * The function used to issue a single `UPDATE ... WHERE inArray(hashItems.id,
 * itemIds)` — drizzle's `inArray` compiles to one bound parameter per id, so
 * a group larger than PostgreSQL's parameter-count ceiling (~65,535) would
 * throw at bind time and roll back the whole enclosing transaction. This
 * matters because a real split (`hash-list-split.db.test.ts`) or a same-mode
 * merge (`campaign-split-create.db.test.ts`) can move well over a million
 * rows in one group.
 *
 * These tests exercise the multi-chunk path directly against a real
 * transaction using the function's optional `batchSize` parameter (default
 * `MOVE_BATCH_SIZE = 1_000` in production) injected down to a small value —
 * so the boundary-crossing behavior is verified with a modest fixture
 * instead of a 1,000+ row perf-style fixture (this repo bans perf tests in
 * CI; see the `no-perf-tests-in-ci` learning).
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
import { moveHashItemsToList } from '../../src/services/hash-items/move-items.js'

// ─── Slugs & state ───────────────────────────────────────────────────────────

const SLUG_PROJ = 'move-items-batch-proj'
const INJECTED_BATCH_SIZE = 3
const TARGET_MODE = 9_999_401

let projId: number

async function cleanup(): Promise<void> {
  await db.delete(projects).where(eq(projects.slug, SLUG_PROJ))
}

beforeAll(async () => {
  await cleanup()
  const [p] = await db
    .insert(projects)
    .values({ name: SLUG_PROJ, slug: SLUG_PROJ })
    .returning({ id: projects.id })
  projId = p!.id
})

afterAll(cleanup)

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function createHashList(name: string): Promise<number> {
  const [list] = await db
    .insert(hashLists)
    .values({ projectId: projId, name, status: 'ready' })
    .returning({ id: hashLists.id })
  return list!.id
}

async function insertHashValues(hashListId: number, values: readonly string[]): Promise<number[]> {
  const rows = await db
    .insert(hashItems)
    .values(values.map((hashValue) => ({ hashListId, hashValue })))
    .returning({ id: hashItems.id })
  return rows.map((r) => r.id)
}

async function itemsOf(hashListId: number) {
  return db.select().from(hashItems).where(eq(hashItems.hashListId, hashListId))
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('moveHashItemsToList — multi-chunk UPDATE', () => {
  it('moves every row and stamps detected_hashcat_mode when itemIds spans more than one batch', async () => {
    const sourceId = await createHashList('move-batch-source')
    const targetId = await createHashList('move-batch-target')

    // 7 items against an injected batch size of 3 forces 3 UPDATEs
    // (3 + 3 + 1) — crosses the chunk boundary twice.
    const values = Array.from({ length: 7 }, (_, i) => `move-batch-hv-${i}`)
    const itemIds = await insertHashValues(sourceId, values)
    expect(itemIds).toHaveLength(7)

    await db.transaction((tx) =>
      moveHashItemsToList(tx, itemIds, targetId, TARGET_MODE, INJECTED_BATCH_SIZE)
    )

    const sourceRemaining = await itemsOf(sourceId)
    expect(sourceRemaining).toHaveLength(0)

    const targetRows = await itemsOf(targetId)
    expect(targetRows).toHaveLength(7)
    expect(targetRows.map((r) => r.id).sort((a, b) => a - b)).toEqual(
      [...itemIds].sort((a, b) => a - b)
    )
    for (const row of targetRows) {
      expect(row.detectedHashcatMode).toBe(TARGET_MODE)
    }
  })

  it('leaves detected_hashcat_mode untouched across chunks when the argument is omitted', async () => {
    const sourceId = await createHashList('move-batch-source-no-mode')
    const targetId = await createHashList('move-batch-target-no-mode')

    const values = Array.from({ length: 5 }, (_, i) => `move-batch-nomode-hv-${i}`)
    const itemIds = await insertHashValues(sourceId, values)

    await db.transaction((tx) =>
      moveHashItemsToList(tx, itemIds, targetId, undefined, INJECTED_BATCH_SIZE)
    )

    const targetRows = await itemsOf(targetId)
    expect(targetRows).toHaveLength(5)
    for (const row of targetRows) {
      expect(row.hashListId).toBe(targetId)
      expect(row.detectedHashcatMode).toBeNull()
    }
  })

  it('is a no-op for an empty itemIds array', async () => {
    const targetId = await createHashList('move-batch-target-empty')

    await db.transaction((tx) =>
      moveHashItemsToList(tx, [], targetId, TARGET_MODE, INJECTED_BATCH_SIZE)
    )

    const targetRows = await itemsOf(targetId)
    expect(targetRows).toHaveLength(0)
  })
})
