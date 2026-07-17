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
 */
import { campaigns, hashItems, hashLists } from '@hashhive/shared'
import { and, count, eq, inArray } from 'drizzle-orm'

import { db } from '../../db/index.js'

export interface SubCampaignHashProgress {
  total: number
  cracked: number
  remaining: number
  percentage: number
}

export interface SubCampaignProgressSummary {
  subCampaignCount: number
  completedSubCampaignCount: number
  /** True only when every mode-bearing sub-campaign counted here has status 'completed'. */
  done: boolean
  totalTasks: number
  completedTasks: number
  tasksFailed: number
  overallProgress: number
  hashProgress: SubCampaignHashProgress | null
}

export interface HashListSplitProgress {
  needsTypeCount: number
  subCampaignProgress: SubCampaignProgressSummary | null
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

  const childIds = children.map((c) => c.id)

  // Every sub-campaign targets exactly one child's hashListId (SU3's
  // confirmSplitCampaign) — a child with no matching row here has no
  // sub-campaign at all.
  const subCampaignRows = await db
    .select({
      status: campaigns.status,
      hashListId: campaigns.hashListId,
      progress: campaigns.progress,
    })
    .from(campaigns)
    .where(and(inArray(campaigns.hashListId, childIds), eq(campaigns.projectId, projectId)))

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

  if (subCampaignRows.length === 0) {
    return { needsTypeCount, subCampaignProgress: null }
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

  const done = completedSubCampaignCount === subCampaignRows.length

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
    },
  }
}
