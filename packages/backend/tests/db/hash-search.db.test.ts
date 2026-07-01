/**
 * Real-DB tests for U10: searchHashes — global hash-search service.
 *
 * searchHashes(projectId, query, { limit, offset }) returns per-list rows for
 * every hash_item whose hashValue matches the query (exact OR ILIKE substring)
 * within the given project's hash lists.
 *
 * Test scenarios:
 * 1. Hash in two lists of the same project — both rows returned with the
 *    correct per-list id/name/crackedAt values.
 * 2. Uncracked match returned alongside cracked ones (R15 — no crackedAt filter).
 * 3. Same hash in ANOTHER project — NOT returned (R16 — strict project scope).
 * 4. No match — empty results array, total 0, no error.
 * 5. ILIKE substring — partial hashValue query returns the matching row.
 * 6. escapeLike safety — literal _ in the query is not treated as a wildcard.
 *    Seed rows `hash-search-under_score` and `hash-search-underXscore`, query
 *    `hash-search-under_score`; only the first row is in results (R17).
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
import { searchHashes } from '../../src/services/hash-items/search.js'

// ─── Slugs & state ───────────────────────────────────────────────────────────

const SLUG_PROJ = 'hash-search-proj'
const SLUG_OTHER = 'hash-search-other'

let projId: number
let listOneId: number
let listTwoId: number
let otherId: number
let otherListId: number

// ─── Seed helpers ────────────────────────────────────────────────────────────

async function cleanup(): Promise<void> {
  await Promise.all([
    db.delete(projects).where(eq(projects.slug, SLUG_PROJ)),
    db.delete(projects).where(eq(projects.slug, SLUG_OTHER)),
  ])
}

// ─── Test lifecycle ──────────────────────────────────────────────────────────

beforeAll(async () => {
  // Defensive cleanup in case a prior run left stale rows.
  await cleanup()

  // Primary project with two hash lists (for multi-list tests).
  const [pMain] = await db
    .insert(projects)
    .values({ name: SLUG_PROJ, slug: SLUG_PROJ })
    .returning({ id: projects.id })
  projId = pMain!.id

  const [l1] = await db
    .insert(hashLists)
    .values({ projectId: projId, name: 'list-one', status: 'ready' })
    .returning({ id: hashLists.id })
  listOneId = l1!.id

  const [l2] = await db
    .insert(hashLists)
    .values({ projectId: projId, name: 'list-two', status: 'ready' })
    .returning({ id: hashLists.id })
  listTwoId = l2!.id

  // Separate project to verify R16 (cross-project isolation).
  const [pOther] = await db
    .insert(projects)
    .values({ name: SLUG_OTHER, slug: SLUG_OTHER })
    .returning({ id: projects.id })
  otherId = pOther!.id

  const [lOther] = await db
    .insert(hashLists)
    .values({ projectId: otherId, name: 'list-other', status: 'ready' })
    .returning({ id: hashLists.id })
  otherListId = lOther!.id
})

afterAll(async () => {
  await cleanup()
})

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('searchHashes — multi-list result', () => {
  it('returns one row per list when the same hashValue appears in two lists of the project', async () => {
    const hashValue = 'hash-search-multi-list-v1'

    await db.insert(hashItems).values([
      { hashListId: listOneId, hashValue },
      { hashListId: listTwoId, hashValue },
    ])

    try {
      const result = await searchHashes(projId, hashValue, {})

      expect(result.total).toBe(2)
      expect(result.results).toHaveLength(2)

      const listIds = result.results.map((r) => r.hashListId)
      expect(listIds).toContain(listOneId)
      expect(listIds).toContain(listTwoId)

      // hashListName is populated from the JOIN
      const names = result.results.map((r) => r.hashListName)
      expect(names).toContain('list-one')
      expect(names).toContain('list-two')
    } finally {
      await db.delete(hashItems).where(eq(hashItems.hashListId, listOneId))
      await db.delete(hashItems).where(eq(hashItems.hashListId, listTwoId))
    }
  })
})

describe('searchHashes — cracked and uncracked (R15)', () => {
  it('returns uncracked rows alongside cracked rows without filtering on crackedAt', async () => {
    const crackedValue = 'hash-search-r15-cracked-v1'
    const uncrackedValue = 'hash-search-r15-uncracked-v1'
    const now = new Date()

    await db.insert(hashItems).values([
      { hashListId: listOneId, hashValue: crackedValue, crackedAt: now, plaintext: 'password' },
      { hashListId: listOneId, hashValue: uncrackedValue },
    ])

    try {
      // 'hash-search-r15' is a substring of both values, so the ILIKE returns both.
      const result = await searchHashes(projId, 'hash-search-r15', {})

      const values = result.results.map((r) => r.hashValue)
      expect(values).toContain(crackedValue)

      const crackedRow = result.results.find((r) => r.hashValue === crackedValue)
      const uncrackedRow = result.results.find((r) => r.hashValue === uncrackedValue)

      expect(crackedRow?.crackedAt).toBeInstanceOf(Date)
      expect(uncrackedRow?.crackedAt).toBeNull()
    } finally {
      await db.delete(hashItems).where(eq(hashItems.hashListId, listOneId))
    }
  })
})

describe('searchHashes — R16 cross-project isolation', () => {
  it('does not return rows that belong to a different project', async () => {
    const sharedValue = 'hash-search-r16-isolation-v1'

    // Same hashValue in both the primary project and the other project.
    await db.insert(hashItems).values([
      { hashListId: listOneId, hashValue: sharedValue },
      { hashListId: otherListId, hashValue: sharedValue },
    ])

    try {
      const result = await searchHashes(projId, sharedValue, {})

      // Only the primary project's row should be returned.
      expect(result.total).toBe(1)
      expect(result.results).toHaveLength(1)
      expect(result.results[0]!.hashListId).toBe(listOneId)

      // The other project's row must not appear.
      const returnedListIds = result.results.map((r) => r.hashListId)
      expect(returnedListIds).not.toContain(otherListId)
    } finally {
      await db.delete(hashItems).where(eq(hashItems.hashListId, listOneId))
      await db.delete(hashItems).where(eq(hashItems.hashListId, otherListId))
    }
  })
})

describe('searchHashes — no match', () => {
  it('returns empty results and total 0 without throwing', async () => {
    const result = await searchHashes(projId, 'hash-search-no-match-xyzzy-v1', {})

    expect(result.results).toHaveLength(0)
    expect(result.total).toBe(0)
    expect(result.limit).toBe(50)
    expect(result.offset).toBe(0)
  })
})

describe('searchHashes — ILIKE substring match', () => {
  it('returns a row when the query is a substring of the hashValue', async () => {
    const hashValue = 'hash-search-ilike-prefix-suffix-v1'
    const partialQuery = 'ilike-prefix'

    await db.insert(hashItems).values({ hashListId: listOneId, hashValue })

    try {
      const result = await searchHashes(projId, partialQuery, {})

      expect(result.total).toBeGreaterThanOrEqual(1)
      const values = result.results.map((r) => r.hashValue)
      expect(values).toContain(hashValue)
    } finally {
      await db.delete(hashItems).where(eq(hashItems.hashListId, listOneId))
    }
  })
})

describe('searchHashes — escapeLike: literal _ is not a wildcard (R17)', () => {
  it('only matches the row whose hashValue contains the literal underscore, not rows that differ at that position', async () => {
    // The underscore in the query must be treated as a literal character, not
    // a single-character wildcard.  If escaping were broken, querying
    // `hash-search-under_score` would also match `hash-search-underXscore`
    // (because _ would match any character).  With escapeLike it must not.
    const literalRow = 'hash-search-under_score'
    const decoyRow = 'hash-search-underXscore'

    await db.insert(hashItems).values([
      { hashListId: listOneId, hashValue: literalRow },
      { hashListId: listOneId, hashValue: decoyRow },
    ])

    try {
      const result = await searchHashes(projId, literalRow, {})

      const values = result.results.map((r) => r.hashValue)
      expect(values).toContain(literalRow)
      expect(values).not.toContain(decoyRow)
    } finally {
      await db.delete(hashItems).where(eq(hashItems.hashListId, listOneId))
    }
  })
})
