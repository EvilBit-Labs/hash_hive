/**
 * Parent split-campaign progress + needs-type aggregation (issue #202, SU5).
 *
 * A split PARENT campaign has no attacks/tasks of its own - all cracking
 * happens on its per-type sub-campaigns (`campaigns.parentCampaignId`).
 * `updateCampaignProgress` (services/campaign-progress.ts) is only ever
 * called with a task's OWN `campaignId`, so it never runs for a parent and
 * the parent campaign's own `progress` JSONB stays empty forever. Rather
 * than adding a new write path on the task-report hot path to propagate
 * child progress up to the parent row, this module computes the parent's
 * aggregate progress on READ by combining each mode-bearing sub-campaign's
 * already-computed `progress` (written by the unchanged per-campaign
 * path). Every read recomputes from each child's live row, so there is no
 * cache-invalidation concern.
 *
 * "Needs a type" sub-lists - children of the parent hash list
 * (`hash_lists.parent_hash_list_id`) whose `type_analysis.verdict ===
 * 'needs-review'` and that have no sub-campaign targeting them (see
 * `campaign-split.ts`'s `applyAssignmentsAndMerge`: still-ambiguous or
 * unidentified groups get no sub-campaign) - are counted SEPARATELY
 * (`needsTypeCount`) and are structurally excluded from
 * `subCampaignProgress` (which only ever iterates campaigns rows, and a
 * needs-type child has none). This is what keeps an otherwise-complete
 * parent from reading as stalled just because some hashes still need a
 * type assigned.
 *
 * "Pending" sub-lists (code review fix, #202) - children that ARE resolved
 * (`type_analysis.verdict === 'homogeneous'`) but have NO sub-campaign
 * linked yet. `confirmSplitCampaign` is not one atomic transaction across
 * its whole flow: `applyAssignmentsAndMerge` flips a child to `homogeneous`
 * in its own transaction, and the parent campaign plus each sub-campaign
 * are created in separate statements afterward. A crash in that window
 * strands a resolved child with no campaign at all - invisible to both
 * `needsTypeCount` (verdict isn't `needs-review`) and
 * `subCampaignProgress` (no campaign row exists). `pendingSubCampaignCount`
 * counts these and forces `subCampaignProgress.done` to `false` whenever
 * it is nonzero, so a partially-confirmed split can never read complete.
 */
import type { SubCampaignHashProgress, SubCampaignProgress } from '@hashhive/shared'

import { campaigns, hashItems, hashLists } from '@hashhive/shared'
import { and, count, eq, inArray, isNull } from 'drizzle-orm'

import { db } from '../../db/index.js'

// `SubCampaignHashProgress` / `SubCampaignProgress` are imported from
// `@hashhive/shared` (AGENTS.md: wire shapes live there as `z.infer` from
// Zod schemas) rather than hand-declared here — see
// `subCampaignHashProgressWireSchema` / `subCampaignProgressWireSchema` in
// `packages/shared/src/schemas/resources.ts`. `HashListSplitProgress`
// itself has no dedicated wire schema (its two fields ride the parent hash
// list detail response as flat top-level fields, not a nested object — see
// `routes/dashboard/resources.ts`), so it stays a plain local composition
// of the two shared types below.
export interface HashListSplitProgress {
  needsTypeCount: number
  subCampaignProgress: SubCampaignProgress | null
}

/** Narrows a `campaigns.progress` jsonb cell to a `Record` (or null for an empty/legacy row). */
function asProgressRecord(progress: unknown): Record<string, unknown> | null {
  return progress && typeof progress === 'object' ? (progress as Record<string, unknown>) : null
}

/** Reads a numeric field `updateCampaignProgress` writes, defaulting to 0 for anything else. */
function readProgressNumber(progress: Record<string, unknown> | null, key: string): number {
  const value = progress?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Reads the cached `hashProgress` sub-object `updateCampaignProgress`
 * writes for a LEAF campaign (`{ total, cracked, remaining, percentage }`),
 * or `null` when the child has no crackable items yet (the field is only
 * written when `stats.totalCount > 0` — see campaign-progress.ts).
 */
function readHashProgress(
  progress: Record<string, unknown> | null
): SubCampaignHashProgress | null {
  const raw = progress?.['hashProgress']
  if (!raw || typeof raw !== 'object') return null
  const hp = raw as Record<string, unknown>
  const total = typeof hp['total'] === 'number' ? hp['total'] : 0
  const cracked = typeof hp['cracked'] === 'number' ? hp['cracked'] : 0
  return {
    total,
    cracked,
    remaining: Math.max(0, total - cracked),
    percentage: total > 0 ? cracked / total : 0,
  }
}

/**
 * Computes `needsTypeCount` and, when the parent has at least one
 * mode-bearing sub-campaign, `subCampaignProgress` for a hash list. Returns
 * `null` for a non-split (leaf) hash list - i.e. one with no children -
 * so callers can omit both fields from the wire response rather than
 * sending zeroes/`null` for the common case.
 */
export async function getHashListSplitProgress(
  hashListId: number,
  projectId: number
): Promise<HashListSplitProgress | null> {
  const children = await db
    .select({ id: hashLists.id, typeAnalysis: hashLists.typeAnalysis })
    .from(hashLists)
    .where(and(eq(hashLists.parentHashListId, hashListId), eq(hashLists.projectId, projectId)))

  if (children.length === 0) return null

  // The split PARENT campaign — the one campaign row created by SU3's
  // confirmSplitCampaign against THIS hash list (hashListId = hashListId,
  // parentCampaignId IS NULL). Sub-campaigns are found via THIS campaign's
  // id, not by "hashListId is one of the children" — a user can create an
  // unrelated campaign directly against a child hash list without ever
  // going through the split-confirm flow, and that campaign must NOT be
  // folded into the parent's aggregate progress. `null` here means the
  // split was materialized (children exist) but never confirmed into a
  // campaign yet — same no-sub-campaign-progress outcome as before.
  const [parentCampaign] = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.hashListId, hashListId),
        eq(campaigns.projectId, projectId),
        isNull(campaigns.parentCampaignId)
      )
    )
    .limit(1)

  const subCampaignRows = parentCampaign
    ? await db
        .select({
          status: campaigns.status,
          hashListId: campaigns.hashListId,
          progress: campaigns.progress,
        })
        .from(campaigns)
        .where(
          and(eq(campaigns.parentCampaignId, parentCampaign.id), eq(campaigns.projectId, projectId))
        )
    : []

  const hashListIdsWithSubCampaign = new Set(subCampaignRows.map((r) => r.hashListId))

  const needsTypeChildIds = children
    .filter(
      (c) => c.typeAnalysis?.verdict === 'needs-review' && !hashListIdsWithSubCampaign.has(c.id)
    )
    .map((c) => c.id)

  let needsTypeCount = 0
  if (needsTypeChildIds.length > 0) {
    const [row] = await db
      .select({ total: count() })
      .from(hashItems)
      .where(inArray(hashItems.hashListId, needsTypeChildIds))
    needsTypeCount = Number(row?.total ?? 0)
  }

  // Mode-bearing (resolved) children with NO linked sub-campaign at all
  // (issue #202 code review fix). `confirmSplitCampaign` is not atomic
  // across its whole flow — `applyAssignmentsAndMerge` flips a child's
  // `type_analysis` to `homogeneous` in one transaction, then the parent
  // campaign and each sub-campaign are created in separate statements
  // afterward. A crash in that window strands a resolved child with no
  // campaign targeting it: invisible to `needsTypeChildIds` (verdict isn't
  // `needs-review`) AND invisible to `subCampaignRows` (no campaign row
  // exists yet). Without this, such a parent can read `done` once every
  // campaign that DID get created finishes, even though a resolved
  // sub-list is still waiting on its own campaign.
  const pendingSubCampaignCount = children.filter(
    (c) => c.typeAnalysis?.verdict === 'homogeneous' && !hashListIdsWithSubCampaign.has(c.id)
  ).length

  if (subCampaignRows.length === 0) {
    if (pendingSubCampaignCount === 0) {
      return { needsTypeCount, subCampaignProgress: null }
    }
    // The confirm crashed before ANY sub-campaign (or even the parent
    // campaign) was created, yet at least one child is already resolved.
    // Surface a zeroed, explicitly-not-done progress object rather than
    // `null` so the parent can't read as "nothing to track" while a
    // resolved split sits half-materialized.
    return {
      needsTypeCount,
      subCampaignProgress: {
        subCampaignCount: 0,
        completedSubCampaignCount: 0,
        done: false,
        totalTasks: 0,
        completedTasks: 0,
        tasksFailed: 0,
        overallProgress: 0,
        hashProgress: null,
        pendingSubCampaignCount,
      },
    }
  }

  let totalTasks = 0
  let completedTasks = 0
  let tasksFailed = 0
  let weightedProgressSum = 0
  let hashTotal = 0
  let hashCracked = 0
  let sawHashProgress = false
  let completedSubCampaignCount = 0

  for (const row of subCampaignRows) {
    const progress = asProgressRecord(row.progress)
    const childTotalTasks = readProgressNumber(progress, 'totalTasks')
    totalTasks += childTotalTasks
    completedTasks += readProgressNumber(progress, 'completedTasks')
    tasksFailed += readProgressNumber(progress, 'tasksFailed')
    weightedProgressSum += readProgressNumber(progress, 'overallProgress') * childTotalTasks

    const hp = readHashProgress(progress)
    if (hp) {
      sawHashProgress = true
      hashTotal += hp.total
      hashCracked += hp.cracked
    }

    if (row.status === 'completed') completedSubCampaignCount += 1
  }

  // A dangling mode-bearing child with no sub-campaign yet (confirm crashed
  // mid-loop) means the split is only partially materialized, regardless
  // of whether every campaign that DID get created has finished.
  const done = completedSubCampaignCount === subCampaignRows.length && pendingSubCampaignCount === 0

  // Mirrors updateCampaignProgress's own zero-task guard: with no tasks
  // reported yet, a fully-`completed` set of children is 100% (e.g. every
  // sub-campaign was cancelled/completed with no attacks); otherwise 0%.
  const overallProgress = totalTasks > 0 ? weightedProgressSum / totalTasks : done ? 1 : 0

  const hashProgress: SubCampaignHashProgress | null = sawHashProgress
    ? {
        total: hashTotal,
        cracked: hashCracked,
        remaining: Math.max(0, hashTotal - hashCracked),
        percentage: hashTotal > 0 ? hashCracked / hashTotal : 0,
      }
    : null

  return {
    needsTypeCount,
    subCampaignProgress: {
      subCampaignCount: subCampaignRows.length,
      completedSubCampaignCount,
      done,
      totalTasks,
      completedTasks,
      tasksFailed,
      overallProgress: Math.round(overallProgress * 10000) / 10000,
      hashProgress,
      pendingSubCampaignCount,
    },
  }
}
