import { hashItems, hashLists } from '@hashhive/shared'
import { eq, sql } from 'drizzle-orm'

/**
 * Campaign-wizard split + review flow (issue #202, unit SU3).
 *
 * Turns the mixed-hash-list dead end (a mixed/needs-review list would
 * otherwise hit `mode_conflict` or silently crack the wrong hash type) into
 * a two-step flow:
 *
 *   1. `createCampaignOrSplit` — the create-path entry point. Reads the
 *      target hash list's persisted `type_analysis.verdict` and branches:
 *        - `null` (never analyzed) or `homogeneous` -> the existing
 *          single-mode path, unchanged (`createCampaignWithAttacks`).
 *        - `mixed` / `needs-review` -> runs `runSplitAnalysis` (the SU2
 *          testable core). `degenerate-empty` is a validation error (no
 *          crackable items). `degenerate-single-group` falls back to the
 *          normal single-mode path on the ORIGINAL hash list (the split
 *          classifier found nothing to split despite the ingestion-time
 *          verdict). `split` / `already-split` return the review groups
 *          instead of creating a campaign — the caller must confirm.
 *   2. `confirmSplitCampaign` — takes the user's per-ambiguous-group mode
 *      assignments, resolves them, merges any groups that land on the same
 *      mode (KTD6), then creates the parent campaign (`parentCampaignId`
 *      null) plus one single-mode sub-campaign per resolved sub-list
 *      (`parentCampaignId` = the parent's id). Confident sub-lists (already
 *      resolved by the original split) get a sub-campaign too, with no
 *      assignment needed. Still-ambiguous (unassigned) and unidentified
 *      sub-lists get no sub-campaign.
 *
 * Not fully atomic end-to-end: the assignment/merge step runs in one
 * transaction, but the parent + sub-campaign creates run as separate
 * sequential transactions afterward (each via the already-transactional
 * `createCampaign`). Nesting them into the merge transaction would open a
 * second `db.transaction()` on a fresh pooled connection while the first is
 * still holding a row lock — a same-process deadlock, not just a race — so
 * this mirrors the rest of the codebase's pattern of chaining independent
 * transactions rather than reworking `createCampaign`/`createCampaignWithAttacks`
 * to accept an external `tx` handle. A crash between steps can leave the
 * merge committed with some/none of the campaigns created; a retry of
 * `confirmSplitCampaign` is safe for the un-created campaigns (the
 * assignments have already been applied, so a second call's assignment
 * validation will reject the affected sub-lists as no-longer-ambiguous) but
 * duplicate campaigns are the operator's problem for now — acceptable for
 * v1 per the unit's scope.
 */
import type { AuditActor } from './audit-log.js'
import type { CreateCampaignWithAttacksResult, InlineAttackInput } from './campaigns.js'

import { db } from '../db/index.js'
import { runSplitAnalysis } from '../queue/workers/hash-list-split.js'
import { createCampaign, createCampaignWithAttacks } from './campaigns.js'
import { moveHashItemsToList } from './hash-items/move-items.js'

// Drizzle transaction handle — the callback argument type of `db.transaction`.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

// ─── Review groups ────────────────────────────────────────────────────────

export interface SplitReviewConfidentGroup {
  id: number
  mode: number
  itemCount: number
}

export interface SplitReviewAmbiguousGroup {
  id: number
  candidateModes: number[]
  itemCount: number
}

export interface SplitReviewUnidentifiedGroup {
  id: number
  itemCount: number
}

export interface SplitReviewGroups {
  parentHashListId: number
  confident: SplitReviewConfidentGroup[]
  ambiguous: SplitReviewAmbiguousGroup[]
  unidentified: SplitReviewUnidentifiedGroup[]
}

/**
 * Categorizes an already-split parent's children for the review UI. Reads
 * `type_analysis` rather than re-counting `hash_items` — SU2 stamps
 * `scannedCount` on every group at split time, so this is a single SELECT
 * with no join.
 */
export async function getSplitReviewGroups(parentHashListId: number): Promise<SplitReviewGroups> {
  const children = await db
    .select()
    .from(hashLists)
    .where(eq(hashLists.parentHashListId, parentHashListId))

  const confident: SplitReviewConfidentGroup[] = []
  const ambiguous: SplitReviewAmbiguousGroup[] = []
  const unidentified: SplitReviewUnidentifiedGroup[] = []

  for (const child of children) {
    const typeAnalysis = child.typeAnalysis
    const itemCount = typeAnalysis?.scannedCount ?? 0

    if (typeAnalysis?.verdict === 'homogeneous') {
      const mode = typeAnalysis.detectedModes[0]?.hashcatMode
      if (mode !== undefined) {
        confident.push({ id: child.id, mode, itemCount })
      }
      continue
    }

    if (typeAnalysis && typeAnalysis.detectedModes.length > 0) {
      ambiguous.push({
        id: child.id,
        candidateModes: typeAnalysis.detectedModes.map((d) => d.hashcatMode),
        itemCount,
      })
      continue
    }

    unidentified.push({ id: child.id, itemCount })
  }

  return { parentHashListId, confident, ambiguous, unidentified }
}

// ─── Create-path entry point ──────────────────────────────────────────────

export type CreateCampaignOrSplitResult =
  | CreateCampaignWithAttacksResult
  // No crackable items at all — the caller (route) maps this to a
  // validation error; there is nothing to build a campaign or a review
  // flow around.
  | { kind: 'split_empty' }
  // Real split happened (or a prior call already split this parent) —
  // the caller must present the review groups and call
  // `confirmSplitCampaign` instead of getting a campaign back directly.
  | ({ kind: 'split_review' } & SplitReviewGroups)

/**
 * Create-path entry point (issue #202 SU3). Same input shape as
 * `createCampaignWithAttacks` — the route calls this instead, and it either
 * passes through to the normal single-mode create (unanalyzed/homogeneous
 * list, or a mixed-verdict list whose split classifier degenerates to one
 * group) or short-circuits into the split/review flow.
 */
export async function createCampaignOrSplit(input: {
  projectId: number
  name: string
  description?: string | undefined
  hashListId: number
  priority?: number | undefined
  createdBy?: number | undefined
  attacks: ReadonlyArray<InlineAttackInput>
  actor?: AuditActor | undefined
}): Promise<CreateCampaignOrSplitResult> {
  const [targetList] = await db
    .select({
      id: hashLists.id,
      projectId: hashLists.projectId,
      typeAnalysis: hashLists.typeAnalysis,
    })
    .from(hashLists)
    .where(eq(hashLists.id, input.hashListId))
    .limit(1)

  // `type_analysis` is nullable (legacy / never-analyzed lists) — treat a
  // missing analysis the same as `homogeneous`: fall through to the normal
  // path unchanged. Also fall through (rather than special-case) when the
  // list doesn't exist or belongs to another project; `createCampaignWithAttacks`
  // already returns the correct typed error (`resource_missing` /
  // `resource_archived`) for those cases via `validateCampaignResources`, so
  // there is no need to duplicate that check here.
  const isMixed =
    targetList !== undefined &&
    targetList.projectId === input.projectId &&
    targetList.typeAnalysis != null &&
    targetList.typeAnalysis.verdict !== 'homogeneous'

  if (!isMixed) {
    return createCampaignWithAttacks(input)
  }

  const splitResult = await runSplitAnalysis(targetList.id)

  if (splitResult.outcome === 'degenerate-empty') {
    return { kind: 'split_empty' }
  }

  if (splitResult.outcome === 'degenerate-single-group') {
    // The split classifier found nothing to split despite the ingestion-time
    // "mixed"/"needs-review" verdict — fall back to a plain single-mode
    // campaign on the ORIGINAL list (its items were never moved).
    return createCampaignWithAttacks(input)
  }

  // 'split' or 'already-split': never create a campaign directly — the
  // caller must present these groups and call `confirmSplitCampaign`.
  const review = await getSplitReviewGroups(targetList.id)
  return { kind: 'split_review', ...review }
}

// ─── Confirm ───────────────────────────────────────────────────────────────

export interface SplitAssignment {
  /** A child hash list of the split parent, currently `ambiguous` (needs-review with candidate modes). */
  subListId: number
  /** Must be one of that sub-list's `type_analysis.detectedModes[].hashcatMode` candidates. */
  mode: number
}

export interface ResolvedSubCampaign {
  id: number
  hashListId: number
  mode: number
  parentCampaignId: number
}

export type ConfirmSplitResult =
  | {
      kind: 'confirmed'
      parentCampaign: NonNullable<Awaited<ReturnType<typeof createCampaign>>>
      subCampaigns: ResolvedSubCampaign[]
    }
  | { kind: 'not_found' }
  | { kind: 'not_split' }
  | { kind: 'invalid_assignment'; reason: string }

interface ResolvedGroup {
  id: number
  mode: number
  itemCount: number
}

/** Recomputes `statistics` + `type_analysis` for a sub-list from its current `hash_items` rows. */
async function recomputeResolvedSubList(tx: Tx, subListId: number, mode: number): Promise<number> {
  const [row] = await tx
    .select({
      total: sql<string>`count(*)`,
      cracked: sql<string>`count(*) filter (where ${hashItems.crackedAt} is not null)`,
    })
    .from(hashItems)
    .where(eq(hashItems.hashListId, subListId))

  // postgres-js returns count(*) as a string at runtime (see hash-lists.ts
  // list route for the same precedent) — coerce before use.
  const totalCount = Number(row?.total ?? 0)
  const crackedCount = Number(row?.cracked ?? 0)
  const analyzedAt = new Date().toISOString()

  await tx
    .update(hashLists)
    .set({
      typeAnalysis: {
        verdict: 'homogeneous',
        detectedModes: [{ hashcatMode: mode, count: totalCount }],
        unidentifiedCount: 0,
        scannedCount: totalCount,
        sampled: false,
        declaredMode: null,
        analyzedAt,
      },
      statistics: {
        totalCount,
        crackedCount,
        crackRate: totalCount > 0 ? crackedCount / totalCount : 0,
        lastUpdated: analyzedAt,
      },
      updatedAt: new Date(),
    })
    .where(eq(hashLists.id, subListId))

  return totalCount
}

/**
 * Applies the caller's assignments to the split parent's ambiguous
 * children, merges any resolved groups (confident-from-split OR
 * newly-assigned) that land on the same mode (KTD6), and returns the final
 * per-mode resolved sub-list set. Row-locks the parent to serialize
 * concurrent confirms on the same split, mirroring `runSplitAnalysis`.
 */
async function applyAssignmentsAndMerge(
  input: {
    projectId: number
    parentHashListId: number
    assignments: ReadonlyArray<SplitAssignment>
  },
  tx: Tx
): Promise<
  | { kind: 'resolved'; groups: ResolvedGroup[] }
  | { kind: 'not_found' }
  | { kind: 'not_split' }
  | { kind: 'invalid_assignment'; reason: string }
> {
  const [parent] = await tx
    .select()
    .from(hashLists)
    .where(eq(hashLists.id, input.parentHashListId))
    .for('update')
    .limit(1)

  if (!parent || parent.projectId !== input.projectId) {
    return { kind: 'not_found' }
  }

  const children = await tx
    .select()
    .from(hashLists)
    .where(eq(hashLists.parentHashListId, parent.id))

  if (children.length === 0) {
    return { kind: 'not_split' }
  }

  const childById = new Map(children.map((c) => [c.id, c]))

  const seenSubListIds = new Set<number>()
  for (const assignment of input.assignments) {
    if (seenSubListIds.has(assignment.subListId)) {
      return {
        kind: 'invalid_assignment',
        reason: `Duplicate assignment for sub-list ${assignment.subListId}`,
      }
    }
    seenSubListIds.add(assignment.subListId)

    const child = childById.get(assignment.subListId)
    if (!child) {
      return {
        kind: 'invalid_assignment',
        reason: `Sub-list ${assignment.subListId} is not a child of hash list ${parent.id}`,
      }
    }

    const typeAnalysis = child.typeAnalysis
    const candidateModes = typeAnalysis?.detectedModes.map((d) => d.hashcatMode) ?? []
    const isAmbiguous = typeAnalysis?.verdict === 'needs-review' && candidateModes.length > 0
    if (!isAmbiguous) {
      return {
        kind: 'invalid_assignment',
        reason: `Sub-list ${assignment.subListId} is not an ambiguous group awaiting review`,
      }
    }
    if (!candidateModes.includes(assignment.mode)) {
      return {
        kind: 'invalid_assignment',
        reason: `Mode ${assignment.mode} is not a candidate for sub-list ${assignment.subListId}`,
      }
    }
  }

  const assignmentBySubListId = new Map(input.assignments.map((a) => [a.subListId, a.mode]))

  // Apply each assignment: stamp `detected_hashcat_mode` on its items and
  // flip the sub-list's `type_analysis` to homogeneous, then collect every
  // now-resolved sub-list (confident-from-split OR just-assigned) for the
  // merge pass below.
  const resolved: ResolvedGroup[] = []
  for (const child of children) {
    const typeAnalysis = child.typeAnalysis

    if (typeAnalysis?.verdict === 'homogeneous') {
      const mode = typeAnalysis.detectedModes[0]?.hashcatMode
      if (mode !== undefined) {
        resolved.push({ id: child.id, mode, itemCount: typeAnalysis.scannedCount })
      }
      continue
    }

    const assignedMode = assignmentBySubListId.get(child.id)
    if (assignedMode === undefined) {
      // Still-ambiguous (unassigned) or unidentified — no sub-campaign.
      continue
    }

    await tx
      .update(hashItems)
      .set({ detectedHashcatMode: assignedMode })
      .where(eq(hashItems.hashListId, child.id))
    const itemCount = await recomputeResolvedSubList(tx, child.id, assignedMode)
    resolved.push({ id: child.id, mode: assignedMode, itemCount })
  }

  // Merge groups sharing the same resolved mode (KTD6). Deterministic
  // target choice: lowest id wins, so re-running against the same data is
  // stable.
  const byMode = new Map<number, ResolvedGroup[]>()
  for (const group of resolved) {
    const bucket = byMode.get(group.mode)
    if (bucket) {
      bucket.push(group)
    } else {
      byMode.set(group.mode, [group])
    }
  }

  const finalGroups: ResolvedGroup[] = []
  for (const [mode, group] of byMode) {
    if (group.length === 1) {
      finalGroups.push(group[0]!)
      continue
    }

    const [target, ...others] = [...group].sort((a, b) => a.id - b.id)
    for (const other of others) {
      const otherItems = await tx
        .select({ id: hashItems.id })
        .from(hashItems)
        .where(eq(hashItems.hashListId, other.id))
      await moveHashItemsToList(
        tx,
        otherItems.map((r) => r.id),
        target!.id,
        mode
      )
      await tx.delete(hashLists).where(eq(hashLists.id, other.id))
    }
    const mergedCount = await recomputeResolvedSubList(tx, target!.id, mode)
    finalGroups.push({ id: target!.id, mode, itemCount: mergedCount })
  }

  return { kind: 'resolved', groups: finalGroups }
}

/**
 * Confirms a split review: resolves the caller's ambiguous-group mode
 * assignments, merges same-mode groups, then creates the parent campaign
 * plus one single-mode sub-campaign per resolved sub-list. See the module
 * doc comment for the atomicity trade-off across this multi-transaction
 * sequence.
 */
export async function confirmSplitCampaign(input: {
  projectId: number
  parentHashListId: number
  name: string
  description?: string | undefined
  priority?: number | undefined
  createdBy?: number | undefined
  assignments: ReadonlyArray<SplitAssignment>
  actor?: AuditActor | undefined
}): Promise<ConfirmSplitResult> {
  const mergeResult = await db.transaction((tx) =>
    applyAssignmentsAndMerge(
      {
        projectId: input.projectId,
        parentHashListId: input.parentHashListId,
        assignments: input.assignments,
      },
      tx
    )
  )

  if (mergeResult.kind !== 'resolved') {
    return mergeResult
  }

  const parentCampaign = await createCampaign(
    {
      projectId: input.projectId,
      name: input.name,
      description: input.description,
      hashListId: input.parentHashListId,
      priority: input.priority,
      createdBy: input.createdBy,
    },
    input.actor
  )
  if (!parentCampaign) {
    throw new Error('confirmSplitCampaign: parent campaign insert returned no row')
  }

  const subCampaigns: ResolvedSubCampaign[] = []
  for (const group of mergeResult.groups) {
    const subCampaign = await createCampaign(
      {
        projectId: input.projectId,
        name: `${input.name} — mode ${group.mode}`,
        hashListId: group.id,
        priority: input.priority,
        createdBy: input.createdBy,
        hashcatMode: group.mode,
        parentCampaignId: parentCampaign.id,
      },
      input.actor
    )
    if (subCampaign) {
      subCampaigns.push({
        id: subCampaign.id,
        hashListId: group.id,
        mode: group.mode,
        parentCampaignId: parentCampaign.id,
      })
    }
  }

  return { kind: 'confirmed', parentCampaign, subCampaigns }
}
