/**
 * Campaign-wizard split + review flow (issue #202, units SU3/SU7).
 *
 * Turns the mixed-hash-list dead end (a mixed/needs-review list would
 * otherwise hit `mode_conflict` or silently crack the wrong hash type) into
 * a three-step flow:
 *
 *   1. `createCampaignOrSplit` — the create-path entry point. Reads the
 *      target hash list's persisted `type_analysis.verdict` and branches:
 *        - `null` (never analyzed) or `homogeneous`, OR the caller passed
 *          `skipSplit: true` -> the existing single-mode path, unchanged
 *          (`createCampaignWithAttacks`).
 *        - `mixed` / `needs-review` with existing children (a prior call
 *          already split this parent) -> returns the review groups
 *          directly, same as before.
 *        - `mixed` / `needs-review` with no children yet -> enqueues the
 *          `HASH_LIST_SPLIT` job (deduped per hash list, see
 *          `enqueueSplitJob` below) and returns `{ kind: 'split_pending' }`
 *          instead of running `runSplitAnalysis` inline. The wizard polls
 *          `GET /campaigns/split/status/{hashListId}`
 *          (`services/campaign-split-status.ts`) for the outcome:
 *          `ready` (children now exist -> review groups), `empty` /
 *          `single_group` (the classifier's two degenerate outcomes,
 *          previously handled synchronously here), or `failed`.
 *   2. `confirmSplitCampaign` — takes the user's per-ambiguous-group mode
 *      assignments, resolves them, merges any groups that land on the same
 *      mode (KTD6), then creates the parent campaign (`parentCampaignId`
 *      null) plus one single-mode sub-campaign per resolved sub-list
 *      (`parentCampaignId` = the parent's id). Confident sub-lists (already
 *      resolved by the original split) get a sub-campaign too, with no
 *      assignment needed. Still-ambiguous (unassigned) and unidentified
 *      sub-lists get no sub-campaign.
 *   3. `getSplitReviewGroups` — shared by the create path (already-split
 *      case) and the status endpoint's `ready` case.
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
import type {
  ResolvedSubCampaign,
  SplitAssignmentRequest,
  SplitReviewAmbiguousGroup,
  SplitReviewConfidentGroup,
  SplitReviewGroups,
  SplitReviewUnidentifiedGroup,
} from '@hashhive/shared'

import { campaigns, hashItems, hashLists } from '@hashhive/shared'
import { and, eq, isNull, sql } from 'drizzle-orm'

import type { AuditActor } from './audit-log.js'
import type { CreateCampaignWithAttacksResult, InlineAttackInput } from './campaigns.js'

import { logger } from '../config/logger.js'
import { db } from '../db/index.js'
import { createCampaign, createCampaignWithAttacks } from './campaigns.js'
import { moveHashItemsToList } from './hash-items/move-items.js'

// Dynamic-import seam so tests can stub the queue access without a live
// Redis, mirroring `services/resources/line-count-trigger.ts`'s `_deps`
// pattern (bun:test's mock.module can't override already-cached dynamic
// imports across files).
export const _campaignSplitDeps = {
  getQueueContext: () => import('../queue/context.js'),
  getQueueConfig: () => import('../config/queue.js'),
}

/**
 * BullMQ jobId for a hash list's split-analysis job — deduped per hash list
 * so a burst of create attempts against the same mixed list collapses to
 * one job. Exported for `services/campaign-split-status.ts`'s status lookup,
 * which reads back this same job by id.
 */
export function splitJobId(hashListId: number): string {
  return `split-${hashListId}`
}

/**
 * How long a terminal split job's `returnvalue`/`failedReason` stays
 * queryable before BullMQ evicts it. This is the ONLY signal available for
 * the two degenerate outcomes (`degenerate-empty` / `degenerate-single-group`)
 * and for a failed job — both leave no `hash_lists` children row to read
 * instead, unlike a real split. Long enough to cover realistic wizard
 * polling; short enough that a terminal job doesn't block a future re-add
 * past this window (BullMQ dedup+eviction gotcha — see project memory).
 * NOTE: BullMQ's `age` unit is SECONDS, not ms.
 */
const SPLIT_JOB_RETENTION_SECONDS = 10 * 60

/**
 * Enqueues the async split-analysis job for a mixed hash list (issue #202
 * SU7). Best-effort: a missing queue manager or an enqueue throw is
 * swallowed, never rethrown — mirrors `enqueueLineCount` in
 * `services/resources/line-count-trigger.ts`. A swallowed failure here
 * means the wizard's status poll sits at `pending` forever (degraded mode,
 * same as every other best-effort enqueue trigger in this codebase); it
 * never blocks or fails the `POST /campaigns` request itself.
 */
async function enqueueSplitJob(hashListId: number, projectId: number): Promise<void> {
  try {
    const { getQueueManager } = await _campaignSplitDeps.getQueueContext()
    const { QUEUE_NAMES } = await _campaignSplitDeps.getQueueConfig()
    const qm = getQueueManager()
    if (!qm) return
    await qm.enqueue(
      QUEUE_NAMES.HASH_LIST_SPLIT,
      { hashListId, projectId },
      {
        jobId: splitJobId(hashListId),
        removeOnComplete: { age: SPLIT_JOB_RETENTION_SECONDS },
        removeOnFail: { age: SPLIT_JOB_RETENTION_SECONDS },
      }
    )
  } catch (err) {
    logger.warn({ err, hashListId }, 'failed to enqueue hash-list-split job')
  }
}

// Drizzle transaction handle — the callback argument type of `db.transaction`.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

// ─── Review groups ────────────────────────────────────────────────────────
//
// `SplitReviewConfidentGroup` / `SplitReviewAmbiguousGroup` /
// `SplitReviewUnidentifiedGroup` / `SplitReviewGroups` are imported from
// `@hashhive/shared` (AGENTS.md: wire shapes live there as `z.infer` from
// Zod schemas) rather than hand-declared here — see
// `packages/shared/src/schemas/campaign-split.ts`.

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
  // The target list is mixed, no prior call has split it yet, and the
  // caller didn't pass `skipSplit` — the async split job was enqueued (or
  // best-effort attempted; see `enqueueSplitJob`). No campaign was created;
  // the caller must poll `GET /campaigns/split/status/{hashListId}` for the
  // outcome.
  | { kind: 'split_pending'; hashListId: number }
  // A prior call already split this parent — the caller must present the
  // review groups and call `confirmSplitCampaign` instead of getting a
  // campaign back directly.
  | ({ kind: 'split_review' } & SplitReviewGroups)

/**
 * Create-path entry point (issue #202 SU3/SU7). Same input shape as
 * `createCampaignWithAttacks` (plus the optional `skipSplit` escape hatch)
 * — the route calls this instead, and it either passes through to the
 * normal single-mode create (unanalyzed/homogeneous list, `skipSplit: true`,
 * or a mixed-verdict list whose already-split children collapsed to none)
 * or short-circuits into the split-pending / split-review flow.
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
  // Issue #202 SU7: forces the normal single-mode create even when the
  // target list's `type_analysis.verdict` is mixed/needs-review. Set by the
  // wizard's `single_group` fallback after the async split job found
  // nothing to split.
  skipSplit?: boolean | undefined
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

  if (input.skipSplit) {
    return createCampaignWithAttacks(input)
  }

  const existingChildren = await db
    .select({ id: hashLists.id })
    .from(hashLists)
    .where(eq(hashLists.parentHashListId, targetList.id))
    .limit(1)

  if (existingChildren.length > 0) {
    // A prior call already split this parent — never create a campaign
    // directly; the caller must present these groups and call
    // `confirmSplitCampaign`.
    const review = await getSplitReviewGroups(targetList.id)
    return { kind: 'split_review', ...review }
  }

  // First call against this mixed parent: enqueue the async split job
  // instead of running `runSplitAnalysis` inline (issue #202 SU7 — the
  // plan's KTD2 requires this to be an async job the wizard polls, not
  // synchronous request-path work). The two degenerate outcomes
  // (`degenerate-empty` / `degenerate-single-group`) that used to be
  // handled here synchronously now surface through the status poll.
  await enqueueSplitJob(targetList.id, input.projectId)
  return { kind: 'split_pending', hashListId: targetList.id }
}

// ─── Confirm ───────────────────────────────────────────────────────────────
//
// `SplitAssignmentRequest` (a sub-list id + the mode assigned to it) and
// `ResolvedSubCampaign` are imported from `@hashhive/shared` above rather
// than hand-declared here — see `packages/shared/src/schemas/campaign-split.ts`.

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
    assignments: ReadonlyArray<SplitAssignmentRequest>
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
  assignments: ReadonlyArray<SplitAssignmentRequest>
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

  // Idempotency guard (P2 code review fix): an all-confident split has an
  // empty `assignments` payload, so a client retry (e.g. a timeout after
  // the server already committed) would otherwise re-run the merge
  // (harmless — the resolved groups recompute to the same result) and then
  // create a SECOND full parent + sub-campaign set, since
  // `campaigns.hashListId` carries no unique constraint. Detect a prior
  // confirm by looking for the parent campaign this call would otherwise
  // create — a campaign already targeting `parentHashListId` with no
  // `parentCampaignId` of its own — and, if found, reconstruct the
  // response from the existing rows instead of creating duplicates.
  const [existingParentCampaign] = await db
    .select()
    .from(campaigns)
    .where(
      and(
        eq(campaigns.hashListId, input.parentHashListId),
        eq(campaigns.projectId, input.projectId),
        isNull(campaigns.parentCampaignId)
      )
    )
    .limit(1)

  if (existingParentCampaign) {
    const existingSubCampaignRows = await db
      .select()
      .from(campaigns)
      .where(
        and(
          eq(campaigns.parentCampaignId, existingParentCampaign.id),
          eq(campaigns.projectId, input.projectId)
        )
      )

    const existingSubCampaigns: ResolvedSubCampaign[] = existingSubCampaignRows.map((sub) => {
      if (sub.hashcatMode === null) {
        // A sub-campaign created via this flow always latches hashcatMode
        // at insert time (see createCampaign below) — a null here means
        // the row was never actually created by confirmSplitCampaign, so
        // surface it loudly rather than shipping a bogus `mode: 0`.
        throw new Error(`confirmSplitCampaign: existing sub-campaign ${sub.id} has no hashcatMode`)
      }
      return {
        id: sub.id,
        hashListId: sub.hashListId,
        mode: sub.hashcatMode,
        parentCampaignId: existingParentCampaign.id,
      }
    })

    return {
      kind: 'confirmed',
      parentCampaign: existingParentCampaign,
      subCampaigns: existingSubCampaigns,
    }
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
