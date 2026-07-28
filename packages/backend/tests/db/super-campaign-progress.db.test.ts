/**
 * Real-DB tests for issue #101 U11 — aggregate progress / results / ETA for a
 * super PARENT campaign, computed at READ time over its sub-campaigns and the
 * deduplicated leaf union.
 *
 * The two axes are proved separately (adversarial F6):
 *
 *   (a) Cracked-count / results — the DEDUPLICATED union. A value present as
 *       separate `hash_items` rows under two members, cracked once in the
 *       project cracked-set, counts ONCE — never twice. `total` is the raw
 *       union row count; `cracked` is the deduped distinct-value count.
 *   (b) Completion counts — `subCampaignCount` / `completedSubCampaignCount` /
 *       `done` are factual tallies over the sub-campaigns found by THIS parent's
 *       id, and an unrelated campaign a user created directly against a leaf
 *       (no `parentCampaignId`) must NOT pollute them.
 *
 * The critical-path ETA state logic (axis b's function) has exhaustive
 * combinatorial coverage in `tests/unit/super-campaign-eta.test.ts`; here we
 * only assert the rollup returns a well-formed ETA wired to the real subs.
 *
 * The cracked-set is populated by DIRECT INSERTS into `project_cracked_hashes`
 * (matching how the U2 write path stamps it), mirroring `crack-resolution`.
 *
 * Runs under `just test-db` (preload: tests/preload-db.ts). Uses the shared
 * drizzle client from `../../src/db/index.js`.
 *
 * NOTE: Do NOT call client.end() — the pooled client is a process-wide
 * singleton shared by every file in the lane.
 * NOTE: Do NOT self-skip — the test-db lane always has Postgres available.
 */

import type { HashListTypeAnalysis } from '@hashhive/shared'

import {
  campaigns,
  hashItems,
  hashLists,
  projectCrackedHashes,
  projects,
  superHashListMembers,
  superHashLists,
} from '@hashhive/shared'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'

import { db } from '../../src/db/index.js'
import { getSuperCampaignProgress } from '../../src/services/super-campaign-progress.js'

const SLUG = 'super-campaign-progress-proj'

// Modes unique to this file so a stray row from another db-lane file sharing a
// value can never satisfy a `(mode, value)` cracked-set lookup here.
const NTLM_MODE = 9_711_000
const SHA_MODE = 9_711_800

let projId = 0
let seq = 0

function homogeneous(mode: number, count = 1): HashListTypeAnalysis {
  return {
    verdict: 'homogeneous',
    detectedModes: [{ hashcatMode: mode, count }],
    unidentifiedCount: 0,
    scannedCount: count,
    sampled: false,
    declaredMode: null,
    analyzedAt: new Date().toISOString(),
  }
}

async function cleanup(): Promise<void> {
  // Project cascade removes hashLists / hash_items / super tables / campaigns /
  // project_cracked_hashes (all FK ON DELETE CASCADE from projectId).
  await db.delete(projects).where(eq(projects.slug, SLUG))
}

async function createList(name: string, typeAnalysis: HashListTypeAnalysis): Promise<number> {
  seq += 1
  const [row] = await db
    .insert(hashLists)
    .values({ projectId: projId, name: `${name}-${seq}`, status: 'ready', typeAnalysis })
    .returning({ id: hashLists.id })
  return row!.id
}

/** Insert an uncracked hash item carrying its resolved hashcat mode (KTD3). */
async function insertItem(hashListId: number, hashValue: string, mode: number): Promise<void> {
  await db.insert(hashItems).values({ hashListId, hashValue, detectedHashcatMode: mode })
}

/** Record a crack in the project cracked-set (as the U2 write path would). */
async function recordCrack(
  mode: number,
  hashValue: string,
  sourceHashListId: number
): Promise<void> {
  await db.insert(projectCrackedHashes).values({
    projectId: projId,
    hashcatMode: mode,
    hashValue,
    plaintext: 'cracked-secret',
    crackedAt: new Date(),
    originalCrackedAt: new Date('2026-01-02T03:04:05.000Z'),
    sourceHashListId,
  })
}

async function createSuper(name: string, memberIds: number[]): Promise<number> {
  seq += 1
  const [superRow] = await db
    .insert(superHashLists)
    .values({ projectId: projId, name: `${name}-${seq}` })
    .returning({ id: superHashLists.id })
  const superId = superRow!.id
  await db
    .insert(superHashListMembers)
    .values(memberIds.map((memberHashListId) => ({ superHashListId: superId, memberHashListId })))
  return superId
}

/** A super PARENT campaign: carries superHashListId, NO hashListId, no parent. */
async function createSuperParent(name: string, superHashListId: number): Promise<number> {
  seq += 1
  const [row] = await db
    .insert(campaigns)
    .values({ projectId: projId, name: `${name}-${seq}`, superHashListId, status: 'running' })
    .returning({ id: campaigns.id })
  return row!.id
}

/** A leaf sub-campaign: single hashListId, links to the parent (U10 shape). */
async function createSubCampaign(
  name: string,
  hashListId: number,
  parentCampaignId: number,
  status: string,
  hashcatMode: number
): Promise<number> {
  seq += 1
  const [row] = await db
    .insert(campaigns)
    .values({
      projectId: projId,
      name: `${name}-${seq}`,
      hashListId,
      parentCampaignId,
      status,
      hashcatMode,
    })
    .returning({ id: campaigns.id })
  return row!.id
}

beforeAll(async () => {
  await cleanup()
  const [p] = await db
    .insert(projects)
    .values({ name: 'super-campaign-progress test project', slug: SLUG })
    .returning({ id: projects.id })
  projId = p!.id
})

afterAll(async () => {
  await cleanup()
})

describe('getSuperCampaignProgress — axis (a): deduplicated cracked-count over the leaf union', () => {
  it('a value present in TWO members, cracked once, counts once; total is the raw union row count', async () => {
    // Two NTLM members. `shared` exists as a separate row under BOTH (the
    // cross-list dupe R12 warns about); `onlyA` / `onlyB` are unique.
    const listA = await createList('dedup-a', homogeneous(NTLM_MODE))
    const listB = await createList('dedup-b', homogeneous(NTLM_MODE))
    const shared = 'a'.repeat(32)
    const onlyA = 'b'.repeat(32)
    const onlyB = 'c'.repeat(32)
    await insertItem(listA, shared, NTLM_MODE)
    await insertItem(listA, onlyA, NTLM_MODE)
    await insertItem(listB, shared, NTLM_MODE)
    await insertItem(listB, onlyB, NTLM_MODE)

    // `shared` and `onlyA` are cracked in the project set; `onlyB` is not.
    await recordCrack(NTLM_MODE, shared, listA)
    await recordCrack(NTLM_MODE, onlyA, listA)

    const superId = await createSuper('dedup-super', [listA, listB])
    const parentId = await createSuperParent('dedup-parent', superId)

    const progress = await getSuperCampaignProgress({
      parentCampaignId: parentId,
      superHashListId: superId,
      projectId: projId,
    })

    // total = 4 raw union rows (shared counted twice as ROWS — never deduped).
    // cracked = 2 DISTINCT values (shared once + onlyA), NOT 3: the two `shared`
    // rows collapse to one cracked target.
    expect(progress.hashProgress).not.toBeNull()
    expect(progress.hashProgress!.total).toBe(4)
    expect(progress.hashProgress!.cracked).toBe(2)
    expect(progress.hashProgress!.remaining).toBe(2)
    expect(progress.hashProgress!.percentage).toBeCloseTo(0.5, 10)
  })

  it('the SAME value cracked under TWO different modes counts as TWO cracked, not one (AE1 / mixed-mode super)', async () => {
    // A mixed-mode super: one NTLM member, one sha512crypt member, both holding
    // the SAME 32/hex-ish string but cracked under DIFFERENT modes. These are two
    // genuinely distinct cracks — the dedup key is (mode, value), never value
    // alone — so cracked must be 2, matching the U14 export's (mode,value) dedup.
    const ntlmList = await createList('mixmode-ntlm', homogeneous(NTLM_MODE))
    const shaList = await createList('mixmode-sha', homogeneous(SHA_MODE))
    const value = 'f'.repeat(32)
    await insertItem(ntlmList, value, NTLM_MODE)
    await insertItem(shaList, value, SHA_MODE)
    await recordCrack(NTLM_MODE, value, ntlmList)
    await recordCrack(SHA_MODE, value, shaList)

    const superId = await createSuper('mixmode-super', [ntlmList, shaList])
    const parentId = await createSuperParent('mixmode-parent', superId)

    const progress = await getSuperCampaignProgress({
      parentCampaignId: parentId,
      superHashListId: superId,
      projectId: projId,
    })

    expect(progress.hashProgress).not.toBeNull()
    expect(progress.hashProgress!.total).toBe(2)
    // Both distinct (mode, value) cracks count — a value-only dedup would wrongly
    // collapse these to 1.
    expect(progress.hashProgress!.cracked).toBe(2)
    expect(progress.hashProgress!.remaining).toBe(0)
  })

  it('hashProgress is null when the leaf union has no items yet', async () => {
    const empty1 = await createList('empty-1', homogeneous(SHA_MODE))
    const empty2 = await createList('empty-2', homogeneous(SHA_MODE))
    const superId = await createSuper('empty-super', [empty1, empty2])
    const parentId = await createSuperParent('empty-parent', superId)

    const progress = await getSuperCampaignProgress({
      parentCampaignId: parentId,
      superHashListId: superId,
      projectId: projId,
    })

    expect(progress.hashProgress).toBeNull()
  })
})

describe('getSuperCampaignProgress — axis (b): sub-campaign tallies scoped by parent id', () => {
  it('counts only sub-campaigns linked to THIS parent; done flips true only when all are completed', async () => {
    const leafA = await createList('tally-a', homogeneous(NTLM_MODE))
    const leafB = await createList('tally-b', homogeneous(NTLM_MODE))
    await insertItem(leafA, 'd'.repeat(32), NTLM_MODE)
    await insertItem(leafB, 'e'.repeat(32), NTLM_MODE)

    const superId = await createSuper('tally-super', [leafA, leafB])
    const parentId = await createSuperParent('tally-parent', superId)
    await createSubCampaign('tally-sub-a', leafA, parentId, 'completed', NTLM_MODE)
    await createSubCampaign('tally-sub-b', leafB, parentId, 'running', NTLM_MODE)

    // An UNRELATED campaign a user created DIRECTLY against a leaf (no
    // parentCampaignId) must NOT be counted — it is not part of the super
    // fan-out. The parent-id scope is what excludes it.
    seq += 1
    await db.insert(campaigns).values({
      projectId: projId,
      name: `unrelated-null-parent-${seq}`,
      hashListId: leafA,
      status: 'running',
      hashcatMode: NTLM_MODE,
    })

    const progress = await getSuperCampaignProgress({
      parentCampaignId: parentId,
      superHashListId: superId,
      projectId: projId,
    })

    // Exactly the 2 subs linked to this parent are counted; the null-parent
    // direct campaign against the same leaf is excluded. `done` is STATUS-based
    // (one sub still 'running'), independent of the keyspace ETA.
    expect(progress.subCampaignCount).toBe(2)
    expect(progress.completedSubCampaignCount).toBe(1)
    expect(progress.done).toBe(false)

    // ETA is a well-formed rollup wired to the real subs (exhaustive state
    // coverage lives in the unit test).
    expect(progress.eta).toHaveProperty('state')
  })

  it('done is true and eta complete when every sub-campaign is completed', async () => {
    const leaf = await createList('alldone-a', homogeneous(NTLM_MODE))
    await insertItem(leaf, 'f'.repeat(32), NTLM_MODE)
    const leaf2 = await createList('alldone-b', homogeneous(NTLM_MODE))
    await insertItem(leaf2, '0'.repeat(32), NTLM_MODE)

    const superId = await createSuper('alldone-super', [leaf, leaf2])
    const parentId = await createSuperParent('alldone-parent', superId)
    await createSubCampaign('alldone-sub-a', leaf, parentId, 'completed', NTLM_MODE)
    await createSubCampaign('alldone-sub-b', leaf2, parentId, 'completed', NTLM_MODE)

    const progress = await getSuperCampaignProgress({
      parentCampaignId: parentId,
      superHashListId: superId,
      projectId: projId,
    })

    expect(progress.subCampaignCount).toBe(2)
    expect(progress.completedSubCampaignCount).toBe(2)
    expect(progress.done).toBe(true)
    // All subs completed → critical path collapses to complete.
    expect(progress.eta.state).toBe('complete')
  })

  it('no sub-campaigns yet → zero tallies, not done, eta complete (nothing to run)', async () => {
    const leaf = await createList('nosubs-a', homogeneous(NTLM_MODE))
    await insertItem(leaf, '1'.repeat(32), NTLM_MODE)
    const leaf2 = await createList('nosubs-b', homogeneous(NTLM_MODE))
    await insertItem(leaf2, '2'.repeat(32), NTLM_MODE)
    const superId = await createSuper('nosubs-super', [leaf, leaf2])
    const parentId = await createSuperParent('nosubs-parent', superId)

    const progress = await getSuperCampaignProgress({
      parentCampaignId: parentId,
      superHashListId: superId,
      projectId: projId,
    })

    expect(progress.subCampaignCount).toBe(0)
    expect(progress.completedSubCampaignCount).toBe(0)
    expect(progress.done).toBe(false)
    expect(progress.eta).toEqual({ state: 'complete' })
  })
})
