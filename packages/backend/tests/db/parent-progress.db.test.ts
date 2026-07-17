/**
 * Real-DB tests for issue #202 SU5 — parent split-campaign progress +
 * needs-type surfacing (`getHashListSplitProgress` in
 * `packages/backend/src/services/hash-items/split-progress.ts`).
 *
 * A split PARENT campaign has no attacks/tasks of its own, so its progress
 * has to be aggregated on read from its mode-bearing sub-campaigns'
 * already-computed `progress` JSONB — this seeds that shape directly
 * (parent hash list + children + campaigns rows with a hand-set `progress`
 * value, mirroring what `updateCampaignProgress` would have written) rather
 * than driving real task reports through the queue. Mirrors
 * `parent-list-aggregation.db.test.ts` (SU4) and
 * `campaign-split-create.db.test.ts` (SU3)'s fixture conventions.
 *
 * Runs under `just test-db` (preload: tests/preload-db.ts). Uses the shared
 * drizzle client from `../../src/db/index.js`.
 *
 * NOTE: Do NOT call client.end() — the pooled client is a process-wide
 * singleton shared by every file in the lane.
 * NOTE: Do NOT self-skip — the test-db lane always has Postgres available.
 */

import type { HashListTypeAnalysis } from '@hashhive/shared'

import { campaigns, hashItems, hashLists, projects } from '@hashhive/shared'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'

import { db } from '../../src/db/index.js'
import { getHashListSplitProgress } from '../../src/services/hash-items/split-progress.js'

// ─── Fixtures ────────────────────────────────────────────────────────────────

function homogeneousAnalysis(mode: number, itemCount: number): HashListTypeAnalysis {
  return {
    verdict: 'homogeneous',
    detectedModes: [{ hashcatMode: mode, count: itemCount }],
    unidentifiedCount: 0,
    scannedCount: itemCount,
    sampled: false,
    declaredMode: null,
    analyzedAt: new Date().toISOString(),
  }
}

function needsReviewUnidentifiedAnalysis(itemCount: number): HashListTypeAnalysis {
  return {
    verdict: 'needs-review',
    detectedModes: [],
    unidentifiedCount: itemCount,
    scannedCount: itemCount,
    sampled: false,
    declaredMode: null,
    analyzedAt: new Date().toISOString(),
  }
}

function taskProgress(input: {
  totalTasks: number
  completedTasks: number
  tasksFailed: number
  overallProgress: number
  hashTotal: number
  hashCracked: number
}): Record<string, unknown> {
  return {
    totalTasks: input.totalTasks,
    completedTasks: input.completedTasks,
    tasksFailed: input.tasksFailed,
    overallProgress: input.overallProgress,
    updatedAt: new Date().toISOString(),
    hashProgress: {
      total: input.hashTotal,
      cracked: input.hashCracked,
      remaining: input.hashTotal - input.hashCracked,
      percentage: input.hashTotal > 0 ? input.hashCracked / input.hashTotal : 0,
    },
  }
}

// ─── Slugs & state ───────────────────────────────────────────────────────────

const SLUG_PROJ = 'parent-progress-proj'

let projId: number

async function cleanup(): Promise<void> {
  await db.delete(projects).where(eq(projects.slug, SLUG_PROJ))
}

async function insertHashList(
  name: string,
  opts: {
    parentHashListId?: number | null
    typeAnalysis?: HashListTypeAnalysis | null
  } = {}
): Promise<number> {
  const [l] = await db
    .insert(hashLists)
    .values({
      projectId: projId,
      name,
      status: 'ready',
      parentHashListId: opts.parentHashListId ?? null,
      typeAnalysis: opts.typeAnalysis ?? null,
    })
    .returning({ id: hashLists.id })
  return l!.id
}

async function insertItems(hashListId: number, count: number): Promise<void> {
  if (count === 0) return
  await db.insert(hashItems).values(
    Array.from({ length: count }, (_, i) => ({
      hashListId,
      hashValue: `hv-${hashListId}-${i}`,
    }))
  )
}

async function insertCampaign(opts: {
  hashListId: number
  status: string
  parentCampaignId?: number | null
  progress?: Record<string, unknown>
}): Promise<number> {
  const [c] = await db
    .insert(campaigns)
    .values({
      projectId: projId,
      name: `campaign-for-list-${opts.hashListId}`,
      hashListId: opts.hashListId,
      status: opts.status,
      parentCampaignId: opts.parentCampaignId ?? null,
      progress: opts.progress ?? {},
    })
    .returning({ id: campaigns.id })
  return c!.id
}

interface Seed {
  // "complete" scenario: every mode-bearing sub-campaign is done, plus a
  // needs-type child with no sub-campaign at all.
  completeParentId: number
  completeChild1Id: number
  completeChild2Id: number
  completeNeedsTypeChildId: number

  // "partial" scenario: one sub-campaign still running.
  partialParentId: number
  partialChild1Id: number
  partialChild2Id: number

  // Normal, never-split leaf list — regression control.
  leafId: number

  // "rogue" scenario (#202 code review P1): a real split-confirmed parent
  // with one mode-bearing sub-campaign, PLUS an unrelated campaign a user
  // created directly against the sub-campaign's own hash list id (NOT
  // linked via parentCampaignId). That second campaign must not pollute
  // the parent's aggregate.
  rogueParentId: number
  rogueChildId: number
  rogueChildCampaignId: number

  // "stranded" scenario (#202 code review P2): `confirmSplitCampaign`
  // crashed between flipping a child's `type_analysis` to `homogeneous`
  // and creating its sub-campaign. One child has a real, completed
  // sub-campaign; the other is already resolved (mode-bearing) but has NO
  // campaign linked at all.
  strandedParentId: number
  strandedChild1Id: number
  strandedChild2Id: number
}

let seed: Seed

beforeAll(async () => {
  await cleanup()
  const [p] = await db
    .insert(projects)
    .values({ name: SLUG_PROJ, slug: SLUG_PROJ })
    .returning({ id: projects.id })
  projId = p!.id

  // ── "complete" scenario ──────────────────────────────────────────────
  const completeParentId = await insertHashList('complete-parent')
  const completeParentCampaignId = await insertCampaign({
    hashListId: completeParentId,
    status: 'running',
  })

  const completeChild1Id = await insertHashList('complete-child-1', {
    parentHashListId: completeParentId,
    typeAnalysis: homogeneousAnalysis(1000, 10),
  })
  await insertItems(completeChild1Id, 10)
  await insertCampaign({
    hashListId: completeChild1Id,
    status: 'completed',
    parentCampaignId: completeParentCampaignId,
    progress: taskProgress({
      totalTasks: 2,
      completedTasks: 2,
      tasksFailed: 0,
      overallProgress: 1,
      hashTotal: 10,
      hashCracked: 10,
    }),
  })

  const completeChild2Id = await insertHashList('complete-child-2', {
    parentHashListId: completeParentId,
    typeAnalysis: homogeneousAnalysis(1800, 5),
  })
  await insertItems(completeChild2Id, 5)
  await insertCampaign({
    hashListId: completeChild2Id,
    status: 'completed',
    parentCampaignId: completeParentCampaignId,
    progress: taskProgress({
      totalTasks: 1,
      completedTasks: 1,
      tasksFailed: 0,
      overallProgress: 1,
      hashTotal: 5,
      hashCracked: 3,
    }),
  })

  // Needs-type child: no sub-campaign targets it at all.
  const completeNeedsTypeChildId = await insertHashList('complete-child-needs-type', {
    parentHashListId: completeParentId,
    typeAnalysis: needsReviewUnidentifiedAnalysis(4),
  })
  await insertItems(completeNeedsTypeChildId, 4)

  // ── "partial" scenario ───────────────────────────────────────────────
  const partialParentId = await insertHashList('partial-parent')
  const partialParentCampaignId = await insertCampaign({
    hashListId: partialParentId,
    status: 'running',
  })

  const partialChild1Id = await insertHashList('partial-child-1', {
    parentHashListId: partialParentId,
    typeAnalysis: homogeneousAnalysis(1000, 6),
  })
  await insertItems(partialChild1Id, 6)
  await insertCampaign({
    hashListId: partialChild1Id,
    status: 'completed',
    parentCampaignId: partialParentCampaignId,
    progress: taskProgress({
      totalTasks: 2,
      completedTasks: 2,
      tasksFailed: 0,
      overallProgress: 1,
      hashTotal: 6,
      hashCracked: 6,
    }),
  })

  const partialChild2Id = await insertHashList('partial-child-2', {
    parentHashListId: partialParentId,
    typeAnalysis: homogeneousAnalysis(1800, 8),
  })
  await insertItems(partialChild2Id, 8)
  await insertCampaign({
    hashListId: partialChild2Id,
    status: 'running',
    parentCampaignId: partialParentCampaignId,
    progress: taskProgress({
      totalTasks: 4,
      completedTasks: 2,
      tasksFailed: 0,
      overallProgress: 0.5,
      hashTotal: 8,
      hashCracked: 4,
    }),
  })

  // ── Normal, never-split leaf list ────────────────────────────────────
  const leafId = await insertHashList('never-split-leaf')
  await insertItems(leafId, 3)
  await insertCampaign({ hashListId: leafId, status: 'running' })

  // ── "rogue" scenario (#202 code review P1) ───────────────────────────
  // A real split parent + one real sub-campaign (linked via
  // parentCampaignId), PLUS an unrelated campaign a user created directly
  // against the SAME child hash list id without going through
  // confirmSplitCampaign (parentCampaignId left NULL). The old
  // "hashListId is one of the children" query would have folded the
  // rogue campaign's progress into the parent's aggregate too.
  const rogueParentId = await insertHashList('rogue-parent')
  const rogueParentCampaignId = await insertCampaign({
    hashListId: rogueParentId,
    status: 'running',
  })

  const rogueChildId = await insertHashList('rogue-child', {
    parentHashListId: rogueParentId,
    typeAnalysis: homogeneousAnalysis(1000, 10),
  })
  await insertItems(rogueChildId, 10)
  const rogueChildCampaignId = await insertCampaign({
    hashListId: rogueChildId,
    status: 'completed',
    parentCampaignId: rogueParentCampaignId,
    progress: taskProgress({
      totalTasks: 2,
      completedTasks: 2,
      tasksFailed: 0,
      overallProgress: 1,
      hashTotal: 10,
      hashCracked: 10,
    }),
  })

  // The rogue campaign: same hashListId as the real sub-campaign above,
  // but NOT linked via parentCampaignId — must be excluded entirely.
  await insertCampaign({
    hashListId: rogueChildId,
    status: 'running',
    parentCampaignId: null,
    progress: taskProgress({
      totalTasks: 100,
      completedTasks: 0,
      tasksFailed: 0,
      overallProgress: 0,
      hashTotal: 10,
      hashCracked: 0,
    }),
  })

  // ── "stranded" scenario (#202 code review P2) ────────────────────────
  // A real split parent + one real, COMPLETED sub-campaign, PLUS a second
  // child that is already resolved (`type_analysis.verdict ===
  // 'homogeneous'`) but has no campaign linked at all — the exact state a
  // crash between `applyAssignmentsAndMerge`'s child-flip transaction and
  // `confirmSplitCampaign`'s per-group `createCampaign` call would leave
  // behind.
  const strandedParentId = await insertHashList('stranded-parent')
  const strandedParentCampaignId = await insertCampaign({
    hashListId: strandedParentId,
    status: 'running',
  })

  const strandedChild1Id = await insertHashList('stranded-child-1', {
    parentHashListId: strandedParentId,
    typeAnalysis: homogeneousAnalysis(1000, 10),
  })
  await insertItems(strandedChild1Id, 10)
  await insertCampaign({
    hashListId: strandedChild1Id,
    status: 'completed',
    parentCampaignId: strandedParentCampaignId,
    progress: taskProgress({
      totalTasks: 2,
      completedTasks: 2,
      tasksFailed: 0,
      overallProgress: 1,
      hashTotal: 10,
      hashCracked: 10,
    }),
  })

  // Resolved (mode-bearing) but stranded — no campaign row targets it.
  const strandedChild2Id = await insertHashList('stranded-child-2', {
    parentHashListId: strandedParentId,
    typeAnalysis: homogeneousAnalysis(1800, 7),
  })
  await insertItems(strandedChild2Id, 7)

  seed = {
    completeParentId,
    completeChild1Id,
    completeChild2Id,
    completeNeedsTypeChildId,
    partialParentId,
    partialChild1Id,
    partialChild2Id,
    leafId,
    rogueParentId,
    rogueChildId,
    rogueChildCampaignId,
    strandedParentId,
    strandedChild1Id,
    strandedChild2Id,
  }
})

afterAll(cleanup)

describe('getHashListSplitProgress — all sub-campaigns done + a needs-type group', () => {
  it('reads as done, with needsTypeCount surfaced separately (not folded into progress)', async () => {
    const result = await getHashListSplitProgress(seed.completeParentId, projId)
    expect(result).not.toBeNull()

    // 4 needs-type entries, from the one child with no sub-campaign.
    expect(result!.needsTypeCount).toBe(4)

    const sub = result!.subCampaignProgress
    expect(sub).not.toBeNull()
    expect(sub!.subCampaignCount).toBe(2)
    expect(sub!.completedSubCampaignCount).toBe(2)
    expect(sub!.done).toBe(true)
    expect(sub!.overallProgress).toBe(1)
    expect(sub!.totalTasks).toBe(3) // 2 + 1
    expect(sub!.completedTasks).toBe(3)
    expect(sub!.tasksFailed).toBe(0)
  })

  it('the completion denominator excludes the needs-type entries — hashProgress totals only the two mode-bearing children', async () => {
    const result = await getHashListSplitProgress(seed.completeParentId, projId)
    const hashProgress = result!.subCampaignProgress!.hashProgress
    expect(hashProgress).not.toBeNull()
    // 10 (child1) + 5 (child2) = 15 — NOT +4 for the needs-type child's items.
    expect(hashProgress!.total).toBe(15)
    expect(hashProgress!.cracked).toBe(13) // 10 + 3
    expect(hashProgress!.remaining).toBe(2)
  })
})

describe('getHashListSplitProgress — one sub-campaign incomplete', () => {
  it('reflects partial/in-progress: not done, weighted overallProgress between 0 and 1', async () => {
    const result = await getHashListSplitProgress(seed.partialParentId, projId)
    expect(result).not.toBeNull()

    const sub = result!.subCampaignProgress
    expect(sub).not.toBeNull()
    expect(sub!.subCampaignCount).toBe(2)
    expect(sub!.completedSubCampaignCount).toBe(1)
    expect(sub!.done).toBe(false)

    // weighted: (2 tasks * 1.0 + 4 tasks * 0.5) / 6 tasks = 4/6 = 0.6667
    expect(sub!.totalTasks).toBe(6)
    expect(sub!.completedTasks).toBe(4)
    expect(sub!.overallProgress).toBeCloseTo(0.6667, 3)
    expect(sub!.overallProgress).toBeGreaterThan(0)
    expect(sub!.overallProgress).toBeLessThan(1)

    expect(sub!.hashProgress!.total).toBe(14) // 6 + 8
    expect(sub!.hashProgress!.cracked).toBe(10) // 6 + 4
  })

  it('this parent has no needs-type children', async () => {
    const result = await getHashListSplitProgress(seed.partialParentId, projId)
    expect(result!.needsTypeCount).toBe(0)
  })
})

describe('getHashListSplitProgress — non-split (leaf) list', () => {
  it('returns null — no regression, nothing to surface for a normal list', async () => {
    const result = await getHashListSplitProgress(seed.leafId, projId)
    expect(result).toBeNull()
  })
})

describe('getHashListSplitProgress — rogue campaign against a child hash list (#202 P1)', () => {
  it('ignores a campaign targeting a child hashListId that is not linked via parentCampaignId', async () => {
    const result = await getHashListSplitProgress(seed.rogueParentId, projId)
    expect(result).not.toBeNull()

    const sub = result!.subCampaignProgress
    expect(sub).not.toBeNull()
    // Exactly ONE sub-campaign counted — the real one, not the rogue.
    expect(sub!.subCampaignCount).toBe(1)
    expect(sub!.completedSubCampaignCount).toBe(1)
    expect(sub!.done).toBe(true)
    expect(sub!.totalTasks).toBe(2)
    expect(sub!.completedTasks).toBe(2)
    // The rogue campaign's 100 totalTasks / 0 overallProgress must not
    // leak into the aggregate — this would fail with the pre-fix
    // hashListId-in-children query (totalTasks would read 102, done would
    // read false, overallProgress would be dragged toward 0).
    expect(sub!.overallProgress).toBe(1)
    expect(sub!.hashProgress!.total).toBe(10)
    expect(sub!.hashProgress!.cracked).toBe(10)
  })
})

describe('getHashListSplitProgress — stranded mode-bearing child with no sub-campaign (#202 code review P2)', () => {
  it('is NOT done even though every real sub-campaign has completed', async () => {
    const result = await getHashListSplitProgress(seed.strandedParentId, projId)
    expect(result).not.toBeNull()

    const sub = result!.subCampaignProgress
    expect(sub).not.toBeNull()
    // Only ONE real sub-campaign exists (for stranded-child-1), and it's
    // complete — the pre-fix `done` computation would read `true` here.
    expect(sub!.subCampaignCount).toBe(1)
    expect(sub!.completedSubCampaignCount).toBe(1)
    // The dangling resolved child (stranded-child-2) forces `done: false`.
    expect(sub!.pendingSubCampaignCount).toBe(1)
    expect(sub!.done).toBe(false)
  })

  it('does not count the stranded child toward needsTypeCount — it is resolved, not needs-review', async () => {
    const result = await getHashListSplitProgress(seed.strandedParentId, projId)
    expect(result!.needsTypeCount).toBe(0)
  })
})
