/**
 * Real-DB tests for U4 — read-time crack-state resolution against the
 * per-project cracked-set (SuperHashlists Layer one, KTD3 / KTD8 / R15 / R17).
 *
 * `resolveCrackState` (services/hash-items/crack-resolution.ts) is the single
 * way a NON-AGENT read surface turns a `hash_items` row into the crack state an
 * operator should see. These tests prove the SQL-level behavior the mocked
 * route/contract tests cannot:
 *
 *   - Happy path (AE3-shaped): a hash uncracked in list A whose `(mode, value)`
 *     is in the project cracked-set (populated by a crack in sibling list B)
 *     resolves CRACKED with the set's plaintext.
 *   - Mode mismatch (reinforces AE1): the same value cracked under a DIFFERENT
 *     hashcat mode does not mark the item — `(mode, value)` is the key, not the
 *     value alone.
 *   - No-mode item (KTD3): an item whose `detectedHashcatMode` is NULL is never
 *     marked cracked, even when the value is in the cracked-set.
 *   - Own row wins: an item cracked in its own row keeps its own plaintext.
 *   - Cross-project isolation: a cracked-set row in another project never
 *     resolves.
 *   - Match reference (R17): the fill is backed by the row-local
 *     `project_cracked_hashes.sourceHashListId`, and NOTHING a list-A viewer
 *     receives carries list B's identity, `user`, or `source`.
 *   - Integration over the migrated readers: `getHashListStats`,
 *     `getHashItems`, `searchHashes` and the dashboard/control cracked-count
 *     aggregates all reflect a value cracked only in a sibling list of the same
 *     project.
 *
 * The cracked-set is populated by DIRECT INSERTS into `project_cracked_hashes`
 * (matching how the U2 write path stamps it) rather than by running agents —
 * the write path has its own coverage in `cracked-set-write.db.test.ts`.
 *
 * Runs under `just test-db` (preload: tests/preload-db.ts). Uses the shared
 * drizzle client from `../../src/db/index.js`.
 *
 * NOTE: Do NOT call client.end() — the pooled client is a process-wide
 * singleton shared by every file in the lane.
 * NOTE: Do NOT self-skip — the test-db lane always has Postgres available.
 */

import { hashItems, hashLists, projectCrackedHashes, projects } from '@hashhive/shared'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { and, eq, isNotNull, sql } from 'drizzle-orm'

import { db } from '../../src/db/index.js'
import {
  crackedSetJoinOn,
  RESOLVED_CRACKED_VALUE,
  resolveCrackState,
  type ResolvableHashItem,
} from '../../src/services/hash-items/crack-resolution.js'
import { searchHashes } from '../../src/services/hash-items/search.js'
import { getHashItems, getHashListStats } from '../../src/services/resources.js'

const SLUG = 'crack-resolution-test-proj'
const OTHER_SLUG = 'crack-resolution-other-proj'

// Modes unique to this file so a stray row from another db-lane file sharing a
// value can never satisfy a `(mode, value)` lookup here.
const MODE_A = 9_314_001
const MODE_B = 9_314_002

let projectId = 0
let otherProjectId = 0
/** List A — the viewer's list. Its items are uncracked in their own rows. */
let listAId = 0
/** List B — the sibling that produced the crack. Its identity must never leak. */
let listBId = 0

async function cleanup(): Promise<void> {
  // Project cascade removes hashLists/hash_items and project_cracked_hashes
  // (projectId FK is ON DELETE CASCADE).
  await db.delete(projects).where(eq(projects.slug, SLUG))
  await db.delete(projects).where(eq(projects.slug, OTHER_SLUG))
}

let seq = 0

async function createList(projId: number, prefix: string): Promise<number> {
  seq += 1
  const [row] = await db
    .insert(hashLists)
    .values({ projectId: projId, name: `${prefix}-${seq}`, status: 'ready' })
    .returning({ id: hashLists.id })
  return row!.id
}

/** Insert an uncracked hash item carrying an already-resolved hashcat mode. */
async function insertItem(
  hashListId: number,
  hashValue: string,
  opts: {
    detectedHashcatMode?: number | null
    crackedAt?: Date | null
    plaintext?: string | null
    username?: string | null
  } = {}
): Promise<typeof hashItems.$inferSelect> {
  const [row] = await db
    .insert(hashItems)
    .values({
      hashListId,
      hashValue,
      // `??` would be wrong here: an explicit `null` is the KTD3 no-mode case
      // and must survive, so only an ABSENT option falls back to MODE_A.
      detectedHashcatMode:
        opts.detectedHashcatMode === undefined ? MODE_A : opts.detectedHashcatMode,
      crackedAt: opts.crackedAt ?? null,
      plaintext: opts.plaintext ?? null,
      username: opts.username ?? null,
    })
    .returning()
  return row!
}

/**
 * Record a crack in the project cracked-set as if it had been submitted against
 * `sourceHashListId` — the row-local R17 match reference.
 */
async function recordCrack(
  projId: number,
  mode: number,
  hashValue: string,
  plaintext: string,
  sourceHashListId: number | null,
  originalCrackedAt = new Date('2026-01-02T03:04:05.000Z')
): Promise<void> {
  await db.insert(projectCrackedHashes).values({
    projectId: projId,
    hashcatMode: mode,
    hashValue,
    plaintext,
    crackedAt: new Date(),
    originalCrackedAt,
    sourceHashListId,
  })
}

beforeAll(async () => {
  await cleanup()
  const [proj] = await db
    .insert(projects)
    .values({ name: 'crack-resolution test project', slug: SLUG })
    .returning({ id: projects.id })
  projectId = proj!.id
  const [other] = await db
    .insert(projects)
    .values({ name: 'crack-resolution other project', slug: OTHER_SLUG })
    .returning({ id: projects.id })
  otherProjectId = other!.id

  listAId = await createList(projectId, 'crack-res-list-a')
  listBId = await createList(projectId, 'crack-res-list-b')
})

afterAll(async () => {
  await cleanup()
})

describe('resolveCrackState — happy path (cross-list fill)', () => {
  it('reports an item uncracked in its own row as cracked with the cracked-set plaintext', async () => {
    const value = 'crackres-happy-0000000000000000001'
    const item = await insertItem(listAId, value)
    await recordCrack(projectId, MODE_A, value, 'hunter2', listBId)

    const [state] = await resolveCrackState([item], projectId)

    expect(state).toBeDefined()
    expect(state!.cracked).toBe(true)
    expect(state!.plaintext).toBe('hunter2')
    expect(state!.crossList).toBe(true)
    // Provenance time, not the insert-monotonic keyset column.
    expect(state!.crackedAt?.toISOString()).toBe('2026-01-02T03:04:05.000Z')
  })

  it('returns states index-aligned with the input array', async () => {
    const cracked = 'crackres-align-0000000000000000001'
    const uncracked = 'crackres-align-0000000000000000002'
    const itemCracked = await insertItem(listAId, cracked)
    const itemUncracked = await insertItem(listAId, uncracked)
    await recordCrack(projectId, MODE_A, cracked, 'aligned', listBId)

    const states = await resolveCrackState([itemUncracked, itemCracked], projectId)

    expect(states).toHaveLength(2)
    expect(states[0]!.cracked).toBe(false)
    expect(states[1]!.cracked).toBe(true)
    expect(states[1]!.plaintext).toBe('aligned')
  })

  it('issues no query and reports uncracked for an empty batch', async () => {
    expect(await resolveCrackState([], projectId)).toEqual([])
  })
})

describe('resolveCrackState — mode mismatch (reinforces AE1)', () => {
  it('does not mark an item whose mode differs from the cracked-set row of the same value', async () => {
    const value = 'crackres-modemismatch-000000000001'
    // Item detected as MODE_A; the crack was recorded under MODE_B.
    const item = await insertItem(listAId, value, { detectedHashcatMode: MODE_A })
    await recordCrack(projectId, MODE_B, value, 'wrong-mode-plaintext', listBId)

    const [state] = await resolveCrackState([item], projectId)

    expect(state!.cracked).toBe(false)
    expect(state!.plaintext).toBeNull()
    expect(state!.crackedAt).toBeNull()
    expect(state!.crossList).toBe(false)
  })
})

describe('resolveCrackState — no-mode item (KTD3)', () => {
  it('never marks an item whose detectedHashcatMode is null, even when the value is in the cracked-set', async () => {
    const value = 'crackres-nomode-000000000000000001'
    const item = await insertItem(listAId, value, { detectedHashcatMode: null })
    await recordCrack(projectId, MODE_A, value, 'should-not-appear', listBId)
    await recordCrack(projectId, MODE_B, value, 'should-not-appear-either', listBId)

    const [state] = await resolveCrackState([item], projectId)

    expect(state!.cracked).toBe(false)
    expect(state!.plaintext).toBeNull()
  })
})

describe('resolveCrackState — own row wins', () => {
  it('keeps the item own plaintext rather than the cracked-set value', async () => {
    const value = 'crackres-ownrow-000000000000000001'
    const ownCrackedAt = new Date('2026-05-05T00:00:00.000Z')
    const item = await insertItem(listAId, value, {
      crackedAt: ownCrackedAt,
      plaintext: 'own-row-plaintext',
    })
    await recordCrack(projectId, MODE_A, value, 'cracked-set-plaintext', listBId)

    const [state] = await resolveCrackState([item], projectId)

    expect(state!.cracked).toBe(true)
    expect(state!.plaintext).toBe('own-row-plaintext')
    expect(state!.crossList).toBe(false)
    expect(state!.crackedAt?.toISOString()).toBe(ownCrackedAt.toISOString())
  })
})

describe('resolveCrackState — project isolation', () => {
  it('never resolves against a cracked-set row belonging to another project', async () => {
    const value = 'crackres-crossproj-00000000000001'
    const item = await insertItem(listAId, value)
    const otherListId = await createList(otherProjectId, 'crack-res-other-list')
    await recordCrack(otherProjectId, MODE_A, value, 'other-project-secret', otherListId)

    const [state] = await resolveCrackState([item], projectId)

    expect(state!.cracked).toBe(false)
    expect(state!.plaintext).toBeNull()
  })
})

describe('match reference (R17) — recorded row-local, never serialized', () => {
  it('backs the fill with sourceHashListId on the cracked-set row while the resolved state omits every source-list field', async () => {
    const value = 'crackres-r17-00000000000000000001'
    // List B carries distinguishing identity: a username on its own item and a
    // name on the list. Neither may reach a list-A viewer.
    await insertItem(listBId, value, {
      crackedAt: new Date(),
      plaintext: 'shared-secret',
      username: 'listb-operator',
    })
    const itemA = await insertItem(listAId, value)
    await recordCrack(projectId, MODE_A, value, 'shared-secret', listBId)

    // The match reference IS recorded — row-local on the cracked-set.
    const [setRow] = await db
      .select({ sourceHashListId: projectCrackedHashes.sourceHashListId })
      .from(projectCrackedHashes)
      .where(
        and(
          eq(projectCrackedHashes.projectId, projectId),
          eq(projectCrackedHashes.hashcatMode, MODE_A),
          eq(projectCrackedHashes.hashValue, value)
        )
      )
    expect(setRow!.sourceHashListId).toBe(listBId)

    const [state] = await resolveCrackState([itemA], projectId)
    expect(state!.cracked).toBe(true)
    expect(state!.plaintext).toBe('shared-secret')

    // R17: the resolved state carries plaintext + crack state ONLY.
    expect(Object.keys(state!).toSorted()).toEqual([
      'cracked',
      'crackedAt',
      'crossList',
      'plaintext',
    ])
    // The id-substring check is deliberately omitted here: a serial id like
    // `listBId` can be a substring of the ISO timestamp embedded in
    // `JSON.stringify(state)` (e.g. `2026` inside `2026-...`), so it flakes.
    // The structural key assertion above already proves `sourceHashListId`
    // never appears as a field on the resolved state; these string checks
    // stay scoped to identity strings that cannot collide with a timestamp.
    const serialized = JSON.stringify(state)
    expect(serialized).not.toContain('listb-operator')
    expect(serialized.toLowerCase()).not.toContain('crack-res-list-b')
  })

  it('keeps list B identity out of the list-A viewer hash-items page', async () => {
    const value = 'crackres-r17page-000000000000001'
    const listB2 = await createList(projectId, 'crack-res-secret-list-b')
    await insertItem(listB2, value, {
      crackedAt: new Date(),
      plaintext: 'page-secret',
      username: 'secret-operator',
    })
    const listA2 = await createList(projectId, 'crack-res-viewer-list-a')
    await insertItem(listA2, value)
    await recordCrack(projectId, MODE_A, value, 'page-secret', listB2)

    const page = await getHashItems(listA2, projectId, {})
    expect(page).not.toBeNull()
    expect(page!.items).toHaveLength(1)
    const row = page!.items[0]!
    expect(row.plaintext).toBe('page-secret')
    // The resolved timestamp must stay a `Date`, not the raw postgres-js string
    // a coalesce() would otherwise yield — `.mapWith` in crack-resolution.ts is
    // what preserves the wire shape every consumer round-trips through.
    expect(row.crackedAt).toBeInstanceOf(Date)
    // The viewer's own list id is the only hash-list id in the payload.
    expect(row.hashListId).toBe(listA2)

    const serialized = JSON.stringify(page)
    expect(serialized).not.toContain('secret-operator')
    expect(serialized).not.toContain('crack-res-secret-list-b')
    expect(serialized).not.toContain('sourceHashListId')
  })
})

describe('SQL-level resolution — crackedSetJoinOn / RESOLVED_CRACKED_VALUE', () => {
  it('counts a value cracked only in a sibling list as a cracked target of the viewer list', async () => {
    const value = 'crackres-sqlagg-00000000000000001'
    const listA3 = await createList(projectId, 'crack-res-sqlagg-a')
    await insertItem(listA3, value)
    await recordCrack(projectId, MODE_A, value, 'sqlagg', listBId)

    const [row] = await db
      .select({ cracked: sql<string>`count(distinct ${RESOLVED_CRACKED_VALUE})` })
      .from(hashItems)
      .leftJoin(projectCrackedHashes, crackedSetJoinOn(projectId))
      .where(eq(hashItems.hashListId, listA3))

    expect(Number(row!.cracked)).toBe(1)
  })

  it('excludes a mode-mismatched sibling crack from the same aggregate', async () => {
    const value = 'crackres-sqlagg-00000000000000002'
    const listA4 = await createList(projectId, 'crack-res-sqlagg-b')
    await insertItem(listA4, value, { detectedHashcatMode: MODE_A })
    await recordCrack(projectId, MODE_B, value, 'sqlagg-wrong-mode', listBId)

    const [row] = await db
      .select({ cracked: sql<string>`count(distinct ${RESOLVED_CRACKED_VALUE})` })
      .from(hashItems)
      .leftJoin(projectCrackedHashes, crackedSetJoinOn(projectId))
      .where(eq(hashItems.hashListId, listA4))

    expect(Number(row!.cracked)).toBe(0)
  })

  it('does not multiply rows — the join is at most 1:1 via the UNIQUE dedup index', async () => {
    const value = 'crackres-sqlagg-00000000000000003'
    const listA5 = await createList(projectId, 'crack-res-sqlagg-c')
    await insertItem(listA5, value)
    await insertItem(listA5, 'crackres-sqlagg-00000000000000004')
    await recordCrack(projectId, MODE_A, value, 'sqlagg-1to1', listBId)

    const [row] = await db
      .select({ total: sql<string>`count(${hashItems.id})` })
      .from(hashItems)
      .leftJoin(projectCrackedHashes, crackedSetJoinOn(projectId))
      .where(eq(hashItems.hashListId, listA5))

    expect(Number(row!.total)).toBe(2)
  })
})

describe('integration — migrated readers reflect a sibling-list crack', () => {
  it('getHashListStats.crackedCount counts a value cracked only in a sibling list', async () => {
    const listA6 = await createList(projectId, 'crack-res-stats-a')
    const value = 'crackres-stats-000000000000000001'
    await insertItem(listA6, value)
    await insertItem(listA6, 'crackres-stats-000000000000000002')

    const before = await getHashListStats(listA6, projectId)
    expect(before).toEqual({ totalCount: 2, crackedCount: 0, crackRate: 0 })

    await recordCrack(projectId, MODE_A, value, 'stats-secret', listBId)

    const after = await getHashListStats(listA6, projectId)
    expect(after.totalCount).toBe(2)
    expect(after.crackedCount).toBe(1)
    expect(after.crackRate).toBeCloseTo(0.5)
  })

  it('getHashItems status=cracked/uncracked partitions on the resolved state', async () => {
    const listA7 = await createList(projectId, 'crack-res-items-a')
    const crackedValue = 'crackres-items-000000000000000001'
    const uncrackedValue = 'crackres-items-000000000000000002'
    await insertItem(listA7, crackedValue)
    await insertItem(listA7, uncrackedValue)
    await recordCrack(projectId, MODE_A, crackedValue, 'items-secret', listBId)

    const crackedPage = await getHashItems(listA7, projectId, { status: 'cracked' })
    expect(crackedPage!.total).toBe(1)
    expect(crackedPage!.items).toHaveLength(1)
    expect(crackedPage!.items[0]!.hashValue).toBe(crackedValue)
    expect(crackedPage!.items[0]!.plaintext).toBe('items-secret')

    const uncrackedPage = await getHashItems(listA7, projectId, { status: 'uncracked' })
    expect(uncrackedPage!.total).toBe(1)
    expect(uncrackedPage!.items[0]!.hashValue).toBe(uncrackedValue)
    expect(uncrackedPage!.items[0]!.plaintext).toBeNull()
  })

  it('searchHashes reports a sibling-cracked value as cracked', async () => {
    const listA8 = await createList(projectId, 'crack-res-search-a')
    const value = 'crackres-search-00000000000000001'
    await insertItem(listA8, value)

    const before = await searchHashes(projectId, value, {})
    expect(before.results).toHaveLength(1)
    expect(before.results[0]!.crackedAt).toBeNull()

    await recordCrack(projectId, MODE_A, value, 'search-secret', listBId)

    const after = await searchHashes(projectId, value, {})
    expect(after.results).toHaveLength(1)
    // `Date`, not a raw postgres-js timestamptz string — the route calls
    // `.toISOString()` on this value.
    expect(after.results[0]!.crackedAt).toBeInstanceOf(Date)
    // R17: the search row exposes crack state, never the source list.
    expect(JSON.stringify(after.results[0])).not.toContain('crack-res-list-b')
  })

  it('the project-wide dashboard cracked total counts a sibling-only crack once', async () => {
    // Scoped to this file's modes so the shared project's other fixtures do not
    // perturb the number; mirrors the aggregate shape in dashboard/stats.ts.
    const listA9 = await createList(projectId, 'crack-res-total-a')
    const listB9 = await createList(projectId, 'crack-res-total-b')
    const value = 'crackres-total-000000000000000001'
    await insertItem(listA9, value)
    await insertItem(listB9, value)
    await recordCrack(projectId, MODE_A, value, 'total-secret', listB9)

    const [row] = await db
      .select({ count: sql<string>`count(distinct ${RESOLVED_CRACKED_VALUE})` })
      .from(hashItems)
      .innerJoin(hashLists, eq(hashItems.hashListId, hashLists.id))
      .leftJoin(projectCrackedHashes, crackedSetJoinOn(projectId))
      .where(
        and(
          eq(hashLists.projectId, projectId),
          sql`${hashItems.hashValue} = ${value}`,
          // Sanity: neither row is cracked in its own hash_items row.
          sql`${hashItems.crackedAt} is null`
        )
      )

    // One distinct cracked target across two lists, not two.
    expect(Number(row!.count)).toBe(1)
  })
})

describe('sanity — fixtures are uncracked in their own rows', () => {
  it('list A never gained a hash_items crackedAt from the resolver (read-time only, no write-back)', async () => {
    const rows = await db
      .select({ id: hashItems.id })
      .from(hashItems)
      .where(and(eq(hashItems.hashListId, listAId), isNotNull(hashItems.crackedAt)))

    // The only intentionally own-row-cracked fixture in list A is the
    // "own row wins" item.
    expect(rows.length).toBe(1)
  })
})

describe('resolver input contract', () => {
  it('accepts a bare hash_items row shape (structural, no wrapper type needed)', async () => {
    const shapeGuard: ResolvableHashItem = {
      hashValue: 'crackres-shape-000000000000000001',
      detectedHashcatMode: null,
      crackedAt: null,
      plaintext: null,
    }
    const [state] = await resolveCrackState([shapeGuard], projectId)
    expect(state).toEqual({
      cracked: false,
      crackedAt: null,
      plaintext: null,
      crossList: false,
    })
  })
})
