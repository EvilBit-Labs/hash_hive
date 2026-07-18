/**
 * Real-DB tests for issue #202 SU4 — `resolveHashListScope` + the
 * parent-scoped reads routed through it.
 *
 * A split PARENT hash list has its own `hash_items` moved off to its
 * sub-lists (SU1-3), so a read scoped to `parentHashListId` alone would see
 * zero rows unless it expands to `[parentId, ...childIds]`. These tests
 * seed the parent/child shape directly (no need to run the split worker —
 * just `hashLists` rows with `parentHashListId` set + `hashItems` under the
 * children) and assert:
 *
 *   1. `getHashListStats` / `getHashItems` under a PARENT return the union
 *      across children; a LEAF (never-split) list is unchanged (regression).
 *   2. The same cracked `hashValue` under two sibling sub-lists is counted
 *      ONCE in the parent's `crackedCount` (propagateCrack is global —
 *      dedup on hashValue).
 *   3. `resolveHashListScope` never crosses a project boundary (IDOR guard)
 *      — resolving a project A parent id under project B's projectId
 *      returns `[]`.
 *   4. `hashCount`/`totalCount` sum raw rows across children (no dedup —
 *      only the cracked count dedupes).
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
import { resolveHashListScope } from '../../src/services/hash-items/list-scope.js'
import {
  computeHashListEtag,
  getHashItems,
  getHashListStats,
} from '../../src/services/resources.js'

// ─── Slugs & state ───────────────────────────────────────────────────────────

const SLUG_PROJ_A = 'parent-list-agg-proj-a'
const SLUG_PROJ_B = 'parent-list-agg-proj-b'

async function cleanup(): Promise<void> {
  await db.delete(projects).where(eq(projects.slug, SLUG_PROJ_A))
  await db.delete(projects).where(eq(projects.slug, SLUG_PROJ_B))
}

interface Seed {
  projectAId: number
  projectBId: number
  parentId: number
  child1Id: number
  child2Id: number
  leafId: number
}

let seed: Seed

async function insertProject(slug: string): Promise<number> {
  const [p] = await db.insert(projects).values({ name: slug, slug }).returning({ id: projects.id })
  return p!.id
}

async function insertHashList(
  projectId: number,
  name: string,
  parentHashListId: number | null = null
): Promise<number> {
  const [l] = await db
    .insert(hashLists)
    .values({ projectId, name, status: 'ready', parentHashListId })
    .returning({ id: hashLists.id })
  return l!.id
}

async function insertItem(opts: {
  hashListId: number
  hashValue: string
  crackedAt?: Date | null
  plaintext?: string | null
}): Promise<void> {
  await db.insert(hashItems).values({
    hashListId: opts.hashListId,
    hashValue: opts.hashValue,
    crackedAt: opts.crackedAt ?? null,
    plaintext: opts.plaintext ?? null,
  })
}

beforeAll(async () => {
  await cleanup()
  const projectAId = await insertProject(SLUG_PROJ_A)
  const projectBId = await insertProject(SLUG_PROJ_B)

  const parentId = await insertHashList(projectAId, 'split-parent')
  const child1Id = await insertHashList(projectAId, 'split-child-1', parentId)
  const child2Id = await insertHashList(projectAId, 'split-child-2', parentId)
  const leafId = await insertHashList(projectAId, 'never-split-leaf')

  const t1 = new Date('2026-01-01T00:00:00Z')
  const t2 = new Date('2026-01-02T00:00:00Z') // later than t1 — child2's crack should win the etag's max()

  // child1: one uncracked row, one cracked row ('shared-hash')
  await insertItem({ hashListId: child1Id, hashValue: 'alpha-uncracked' })
  await insertItem({
    hashListId: child1Id,
    hashValue: 'shared-hash',
    crackedAt: t1,
    plaintext: 'sharedpw',
  })

  // child2: one uncracked row, one cracked row sharing 'shared-hash' with
  // child1 — this is the propagateCrack-is-global duplicate scenario. Both
  // rows are physically distinct (unique index is per hash_list_id, not
  // global) but represent the SAME cracked target.
  await insertItem({ hashListId: child2Id, hashValue: 'beta-uncracked' })
  await insertItem({
    hashListId: child2Id,
    hashValue: 'shared-hash',
    crackedAt: t2,
    plaintext: 'sharedpw',
  })

  // leaf: a normal, never-split list — untouched by any of the above,
  // used as the regression control.
  await insertItem({ hashListId: leafId, hashValue: 'leaf-uncracked' })
  await insertItem({
    hashListId: leafId,
    hashValue: 'leaf-cracked',
    crackedAt: t1,
    plaintext: 'leafpw',
  })

  seed = { projectAId, projectBId, parentId, child1Id, child2Id, leafId }
})

afterAll(cleanup)

describe('resolveHashListScope', () => {
  it('resolves a leaf list to just its own id', async () => {
    const ids = await resolveHashListScope(seed.leafId, seed.projectAId)
    expect(ids).toEqual([seed.leafId])
  })

  it('resolves a parent to itself plus its direct children', async () => {
    const ids = await resolveHashListScope(seed.parentId, seed.projectAId)
    expect(ids.sort((a, b) => a - b)).toEqual(
      [seed.parentId, seed.child1Id, seed.child2Id].sort((a, b) => a - b)
    )
  })

  it('IDOR guard: returns [] when the id does not belong to the given project', async () => {
    const ids = await resolveHashListScope(seed.parentId, seed.projectBId)
    expect(ids).toEqual([])
  })

  it('IDOR guard: a child id resolved under the wrong project also returns []', async () => {
    const ids = await resolveHashListScope(seed.child1Id, seed.projectBId)
    expect(ids).toEqual([])
  })
})

describe('getHashListStats — parent aggregation', () => {
  it('a LEAF list is unchanged (regression): totalCount/crackedCount match its own rows exactly', async () => {
    const stats = await getHashListStats(seed.leafId, seed.projectAId)
    expect(stats.totalCount).toBe(2)
    expect(stats.crackedCount).toBe(1)
    expect(stats.crackRate).toBe(0.5)
  })

  it('a PARENT sums raw rows across children for totalCount (4 rows: 2 per child, no dedup)', async () => {
    const stats = await getHashListStats(seed.parentId, seed.projectAId)
    expect(stats.totalCount).toBe(4)
  })

  it('a PARENT dedupes crackedCount on hashValue: the shared cracked hash counts ONCE, not twice', async () => {
    const stats = await getHashListStats(seed.parentId, seed.projectAId)
    // Without dedup this would be 2 (one 'shared-hash' row per child).
    expect(stats.crackedCount).toBe(1)
    expect(stats.crackRate).toBe(0.25) // 1 deduped cracked / 4 raw total
  })
})

describe('computeHashListEtag — parent aggregation', () => {
  it('a LEAF list is unchanged (regression)', async () => {
    const etag = await computeHashListEtag(seed.leafId, seed.projectAId)
    expect(etag).toMatch(/^W\/"hl-\d+-\d+-1"$/) // crackedCount component = 1
  })

  it('a PARENT dedupes the crackedCount component and reflects the latest child crack time', async () => {
    const etag = await computeHashListEtag(seed.parentId, seed.projectAId)
    const t2Millis = new Date('2026-01-02T00:00:00Z').getTime()
    // crackedCount component is 1 (deduped 'shared-hash'), not 2.
    expect(etag).toBe(`W/"hl-${seed.parentId}-${t2Millis}-1"`)
  })
})

describe('getHashItems — parent aggregation', () => {
  it('a LEAF list is unchanged (regression): returns exactly its own rows', async () => {
    const result = await getHashItems(seed.leafId, seed.projectAId, {})
    expect(result).not.toBeNull()
    expect(result!.total).toBe(2)
    expect(result!.items.map((i) => i.hashValue).sort()).toEqual(['leaf-cracked', 'leaf-uncracked'])
  })

  it('a PARENT returns the union of rows across children (all 4, both hash_list_ids present)', async () => {
    const result = await getHashItems(seed.parentId, seed.projectAId, {})
    expect(result).not.toBeNull()
    expect(result!.items).toHaveLength(4)
    const hashListIdsSeen = new Set(result!.items.map((i) => i.hashListId))
    expect(hashListIdsSeen).toEqual(new Set([seed.child1Id, seed.child2Id]))
    const hashValuesSeen = result!.items.map((i) => i.hashValue).sort()
    expect(hashValuesSeen).toEqual(
      ['alpha-uncracked', 'beta-uncracked', 'shared-hash', 'shared-hash'].sort()
    )
  })

  it('a PARENT keeps the cracked-status total in sync with the physical rows returned (2, not deduped)', async () => {
    const result = await getHashItems(seed.parentId, seed.projectAId, { status: 'cracked' })
    expect(result).not.toBeNull()
    // total counts the same physical rows `items` pages through — a
    // paginated consumer breaks if total < items.length (PR review: items
    // and total must share cardinality). Unlike getHashListStats.crackedCount
    // (a display-only stat), this total is never deduped by hashValue.
    expect(result!.total).toBe(2)
    expect(result!.items).toHaveLength(2)
    expect(result!.items.every((i) => i.hashValue === 'shared-hash')).toBe(true)
  })

  it('IDOR guard: getHashItems returns null for a parent id resolved under the wrong project', async () => {
    const result = await getHashItems(seed.parentId, seed.projectBId, {})
    expect(result).toBeNull()
  })
})
