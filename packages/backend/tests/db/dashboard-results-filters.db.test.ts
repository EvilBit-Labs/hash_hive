/**
 * Real-DB tests for the Dashboard Results filter predicates + project scoping
 * (GitHub issue #207). PR #204's unit-test `db` mock no-ops `where()`, so the
 * SQL-level predicate behavior was never verified. These run the real
 * `buildResultFilters` conditions against live Postgres through a select that
 * mirrors the route's join shape (see packages/backend/src/routes/dashboard/results.ts).
 *
 * Runs under `just test-db` (preload: tests/preload-db.ts). NOTE: do NOT call
 * client.end() here — the pooled client is a process-wide singleton shared by
 * every file in the lane.
 */

import { attacks, campaigns, hashItems, hashLists, hashTypes, projects } from '@hashhive/shared'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { and, asc, eq } from 'drizzle-orm'

import { db } from '../../src/db/index.js'
import { buildResultFilters } from '../../src/routes/dashboard/results.js'

const TEST_SLUG_A = 'results-filters-test-proj-a'
const TEST_SLUG_B = 'results-filters-test-proj-b'
const HASHCAT_MODE = 9_999_847 // unique to this test file

// Fixed date points: D0 < D1 (start) < DMID < D2 (end) < D3.
const D0 = new Date('2026-01-01T00:00:00Z')
const D1 = new Date('2026-02-01T00:00:00Z')
const DMID = new Date('2026-02-15T00:00:00Z')
const D2 = new Date('2026-03-01T00:00:00Z')
const D3 = new Date('2026-04-01T00:00:00Z')

interface Seed {
  projectAId: number
  projectBId: number
  listAId: number // project A, primary hash list
  listA2Id: number // project A, second hash list (hashListId narrowing)
  listBId: number // project B
  cActiveId: number
  cArchivedId: number
  ids: Record<string, number> // row label -> hash_item id
}

let seed: Seed

async function insertProject(slug: string): Promise<number> {
  const [p] = await db.insert(projects).values({ name: slug, slug }).returning({ id: projects.id })
  return p!.id
}

async function insertList(projectId: number, name: string, hashTypeId: number): Promise<number> {
  const [l] = await db
    .insert(hashLists)
    .values({ projectId, name, hashTypeId, status: 'ready' })
    .returning({ id: hashLists.id })
  return l!.id
}

async function insertCampaign(
  projectId: number,
  hashListId: number,
  overrides: { status?: string; isPermanent?: boolean; archivedAt?: Date | null } = {}
): Promise<number> {
  const [c] = await db
    .insert(campaigns)
    .values({
      name: 'results-filter-campaign',
      projectId,
      hashListId,
      priority: 5,
      status: overrides.status ?? 'running',
      isPermanent: overrides.isPermanent ?? true,
      archivedAt: overrides.archivedAt ?? null,
    })
    .returning({ id: campaigns.id })
  return c!.id
}

async function insertItem(opts: {
  hashListId: number
  hashValue: string
  plaintext?: string | null
  crackedAt?: Date | null
  campaignId?: number | null
}): Promise<number> {
  const [row] = await db
    .insert(hashItems)
    .values({
      hashListId: opts.hashListId,
      hashValue: opts.hashValue,
      plaintext: opts.plaintext ?? null,
      crackedAt: opts.crackedAt ?? null,
      campaignId: opts.campaignId ?? null,
    })
    .returning({ id: hashItems.id })
  return row!.id
}

async function cleanup(): Promise<void> {
  await db.delete(projects).where(eq(projects.slug, TEST_SLUG_A))
  await db.delete(projects).where(eq(projects.slug, TEST_SLUG_B))
  await db.delete(hashTypes).where(eq(hashTypes.hashcatMode, HASHCAT_MODE))
}

/**
 * Run the Results filter conditions against the real DB, mirroring the route's
 * join shape (inner-join hash_lists for scoping, left-join campaigns so
 * deleted/archived-campaign rows survive). Returns the matching hash_item ids.
 */
async function runFilter(
  projectId: number,
  filters: {
    campaignId?: number
    hashListId?: number
    q?: string
    startDate?: string
    endDate?: string
  }
): Promise<number[]> {
  const conditions = buildResultFilters(projectId, filters)
  const rows = await db
    .select({ id: hashItems.id })
    .from(hashItems)
    .innerJoin(hashLists, eq(hashItems.hashListId, hashLists.id))
    .leftJoin(campaigns, eq(hashItems.campaignId, campaigns.id))
    .leftJoin(attacks, eq(hashItems.attackId, attacks.id))
    .where(and(...conditions))
    // Deterministic order so single-row toEqual assertions stay order-stable.
    .orderBy(asc(hashItems.id))
  return rows.map((r) => r.id)
}

beforeAll(async () => {
  await cleanup()
  const projectAId = await insertProject(TEST_SLUG_A)
  const projectBId = await insertProject(TEST_SLUG_B)
  const [ht] = await db
    .insert(hashTypes)
    .values({ name: 'MD5 (results-filter test)', hashcatMode: HASHCAT_MODE })
    .returning({ id: hashTypes.id })
  const hashTypeId = ht!.id

  const listAId = await insertList(projectAId, 'list-a', hashTypeId)
  const listA2Id = await insertList(projectAId, 'list-a2', hashTypeId)
  const listBId = await insertList(projectBId, 'list-b', hashTypeId)

  const cActiveId = await insertCampaign(projectAId, listAId, { status: 'running' })
  const cArchivedId = await insertCampaign(projectAId, listAId, {
    status: 'completed',
    isPermanent: true,
    archivedAt: new Date(),
  })

  const ids: Record<string, number> = {}
  // Project A / list A
  ids['r1'] = await insertItem({
    hashListId: listAId,
    hashValue: 'aaa1',
    plaintext: 'Secret',
    crackedAt: D1,
    campaignId: cActiveId,
  })
  ids['r2'] = await insertItem({
    hashListId: listAId,
    hashValue: 'aaa2',
    plaintext: 'hello',
    crackedAt: D2,
    campaignId: cArchivedId,
  })
  ids['r3'] = await insertItem({
    hashListId: listAId,
    hashValue: 'aaa3',
    plaintext: 'x',
    crackedAt: D0,
  })
  ids['r4'] = await insertItem({
    hashListId: listAId,
    hashValue: 'aaa4',
    plaintext: 'y',
    crackedAt: D3,
  })
  ids['r5'] = await insertItem({
    hashListId: listAId,
    hashValue: 'aaa5',
    plaintext: '50%off',
    crackedAt: DMID,
    campaignId: null,
  })
  ids['r6'] = await insertItem({
    hashListId: listAId,
    hashValue: 'aaa6',
    plaintext: 'z',
    crackedAt: null,
  }) // uncracked
  ids['r7'] = await insertItem({
    hashListId: listAId,
    hashValue: 'aaa7',
    plaintext: 'a_b',
    crackedAt: DMID,
  })
  ids['r9'] = await insertItem({
    hashListId: listAId,
    hashValue: 'aaa9',
    plaintext: 'axb',
    crackedAt: DMID,
  })
  // %-escape decoy: an unescaped `%` (wildcard) in q='50%off' would also match
  // '50zoff'; a correctly-escaped literal `%` must not.
  ids['r10'] = await insertItem({
    hashListId: listAId,
    hashValue: 'ddd10',
    plaintext: '50zoff',
    crackedAt: DMID,
  })
  // literal backslash, for the \-escape test
  ids['r11'] = await insertItem({
    hashListId: listAId,
    hashValue: 'eee11',
    plaintext: 'a\\b',
    crackedAt: DMID,
  })
  // Project A / list A2 (hashListId narrowing)
  ids['r8'] = await insertItem({
    hashListId: listA2Id,
    hashValue: 'bbb8',
    plaintext: 'q',
    crackedAt: DMID,
  })
  // Project B (cross-project exclusion)
  ids['rB'] = await insertItem({
    hashListId: listBId,
    hashValue: 'ccc9',
    plaintext: 'Secret',
    crackedAt: DMID,
  })

  seed = { projectAId, projectBId, listAId, listA2Id, listBId, cActiveId, cArchivedId, ids }
})

afterAll(cleanup)

describe('Results filters: base scoping (R5, R6)', () => {
  it('returns only cracked rows in the scoped project; excludes uncracked and cross-project', async () => {
    const got = await runFilter(seed.projectAId, {})
    const { ids } = seed
    // cracked project-A rows present (incl. archived-campaign and null-campaign attribution)
    expect(got).toContain(ids['r1'])
    expect(got).toContain(ids['r2']) // archived campaign's crack still attributes
    expect(got).toContain(ids['r5']) // null campaign_id still appears via hash-list scope
    expect(got).toContain(ids['r8']) // other hash list, same project
    // excluded
    expect(got).not.toContain(ids['r6']) // uncracked (cracked_at IS NULL)
    expect(got).not.toContain(ids['rB']) // other project
  })

  it('scopes to project B independently', async () => {
    const got = await runFilter(seed.projectBId, {})
    expect(got).toEqual([seed.ids['rB']])
  })
})

describe('Results filters: date range (R1, R2)', () => {
  it('treats startDate and endDate as inclusive (gte/lte)', async () => {
    const got = await runFilter(seed.projectAId, {
      startDate: D1.toISOString(),
      endDate: D2.toISOString(),
    })
    expect(got).toContain(seed.ids['r1']) // exactly == startDate
    expect(got).toContain(seed.ids['r2']) // exactly == endDate
    expect(got).not.toContain(seed.ids['r3']) // before startDate
    expect(got).not.toContain(seed.ids['r4']) // after endDate
  })

  it('returns zero rows when startDate is after endDate', async () => {
    const got = await runFilter(seed.projectAId, {
      startDate: D2.toISOString(),
      endDate: D1.toISOString(),
    })
    expect(got).toEqual([])
  })
})

describe('Results filters: q ILIKE + escapeLike (R3)', () => {
  it('matches case-insensitively across plaintext', async () => {
    const got = await runFilter(seed.projectAId, { q: 'secret' })
    expect(got).toEqual([seed.ids['r1']]) // 'Secret' in project A; project-B 'Secret' excluded by scope
  })

  it('matches against hash_value', async () => {
    const got = await runFilter(seed.projectAId, { q: 'aaa1' })
    expect(got).toEqual([seed.ids['r1']])
  })

  it('treats % as a literal, not a wildcard (escapeLike)', async () => {
    // r10 ('50zoff') is the decoy a wildcard `%` would also match.
    const got = await runFilter(seed.projectAId, { q: '50%off' })
    expect(got).toEqual([seed.ids['r5']])
  })

  it('treats a literal backslash as data, not an escape char (escapeLike)', async () => {
    const got = await runFilter(seed.projectAId, { q: 'a\\b' })
    expect(got).toEqual([seed.ids['r11']])
  })

  it('treats _ as a literal, not a single-char wildcard (escapeLike)', async () => {
    const got = await runFilter(seed.projectAId, { q: 'a_b' })
    expect(got).toContain(seed.ids['r7']) // literal 'a_b'
    expect(got).not.toContain(seed.ids['r9']) // 'axb' must NOT match if _ were a wildcard
  })
})

describe('Results filters: campaign / hash-list narrowing (R4)', () => {
  it('narrows by campaignId', async () => {
    expect(await runFilter(seed.projectAId, { campaignId: seed.cActiveId })).toEqual([
      seed.ids['r1'],
    ])
    expect(await runFilter(seed.projectAId, { campaignId: seed.cArchivedId })).toEqual([
      seed.ids['r2'],
    ])
  })

  it('narrows by hashListId', async () => {
    expect(await runFilter(seed.projectAId, { hashListId: seed.listA2Id })).toEqual([
      seed.ids['r8'],
    ])
  })
})

describe('Results filters: combined predicates', () => {
  it('ANDs campaign + date range + q together', async () => {
    const got = await runFilter(seed.projectAId, {
      campaignId: seed.cActiveId,
      startDate: D1.toISOString(),
      endDate: D2.toISOString(),
      q: 'secret',
    })
    expect(got).toEqual([seed.ids['r1']])
  })
})
