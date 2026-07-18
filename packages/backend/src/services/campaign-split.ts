/**
 * Campaign-wizard split + review flow (issue #202, units SU3/SU7).
 *
 * Turns the mixed-hash-list dead end (a mixed/needs-review list would
 * otherwise hit `mode_conflict` or silently crack the wrong hash type) into
 * a three-step flow:
 *
 *   1. `createCampaignOrSplit` — the create-path entry point. Reads the
 *      target hash list's persisted `type_analysis.verdict` and branches:
 *        - `null` (never analyzed) or `homogeneous` -> the existing
 *          single-mode path, unchanged (`createCampaignWithAttacks`).
 *        - `mixed` / `needs-review` with the caller passing
 *          `skipSplit: true` -> honored ONLY after `verifiesSingleGroup`
 *          re-confirms the list currently resolves to one classification
 *          group (see that function's doc comment); otherwise rejected as
 *          `skip_split_rejected` rather than silently creating a
 *          wrong-mode campaign (security fix — CodeRabbit).
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
 *      assignment needed. An unidentified (needs-type) sub-list legitimately
 *      gets no sub-campaign. A still-ambiguous (unassigned) sub-list is
 *      REJECTED (`invalid_assignment`) rather than silently skipped (bug fix
 *      — CodeRabbit, Major correctness): omitting it used to return
 *      `confirmed` while those hashes were left genuinely unresolved with no
 *      sub-campaign and no signal to the caller.
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
 * to accept an external `tx` handle.
 *
 * A crash between steps can leave the merge committed with some/none of the
 * campaigns created. `confirmSplitCampaign` is self-healing across a
 * SEQUENTIAL retry of the SAME call (code review fix): `applyAssignmentsAndMerge`
 * tolerates re-submitting an assignment a prior run already applied — same
 * subListId, now homogeneous, resolved to the EXACT mode requested — as a
 * no-op instead of rejecting it as no-longer-ambiguous. Anything else
 * (unknown subListId, or already resolved to a DIFFERENT mode) is rejected
 * as `invalid_assignment`, not silently swallowed (follow-up code review
 * fix — see `applyAssignmentsAndMerge`'s inline comment). The parent-campaign
 * lookup that follows backfills any `mergeResult.groups` entry that doesn't already have
 * a linked sub-campaign — a fully-completed prior run backfills nothing, a
 * partial one completes. This does NOT cover genuinely CONCURRENT confirms
 * against the same parent racing each other past the parent-campaign
 * existence check before either has committed its create — that residual
 * duplicate-creation risk is unchanged from before and still the operator's
 * problem for now (acceptable for v1 per the unit's scope; the `for('update')`
 * row lock inside `applyAssignmentsAndMerge` only serializes the merge step,
 * not the campaign creates that follow it in a separate transaction).
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
import { and, asc, eq, isNull, sql } from 'drizzle-orm'

import type { AuditActor } from './audit-log.js'
import type { CreateCampaignWithAttacksResult, InlineAttackInput } from './campaigns.js'

import { logger } from '../config/logger.js'
import { db } from '../db/index.js'
import { createCampaign, createCampaignWithAttacks } from './campaigns.js'
import { MOVE_BATCH_SIZE, moveHashItemsToList } from './hash-items/move-items.js'
import { planSplit } from './hash-items/split-analysis.js'

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
 * SU7). Returns whether the enqueue actually succeeded — a missing queue
 * manager or an enqueue throw both resolve to `false` rather than
 * rethrowing (mirrors `enqueueLineCount` in
 * `services/resources/line-count-trigger.ts` for the never-throw part),
 * but unlike that best-effort trigger the caller (`createCampaignOrSplit`)
 * MUST check this return value: a swallowed `false` here with no caller
 * follow-up would leave no job running and no campaign created, so the
 * wizard's status poll would sit at `pending` forever with no way to
 * recover (code review fix — see `CreateCampaignOrSplitResult`'s
 * `split_enqueue_failed` branch).
 */
async function enqueueSplitJob(hashListId: number, projectId: number): Promise<boolean> {
  try {
    const { getQueueManager } = await _campaignSplitDeps.getQueueContext()
    const { QUEUE_NAMES } = await _campaignSplitDeps.getQueueConfig()
    const qm = getQueueManager()
    if (!qm) return false
    return await qm.enqueue(
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
    return false
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
  // The target list is mixed and unsplit, but the async split job could
  // NOT be enqueued (queue manager unavailable, or the enqueue itself
  // failed). No campaign was created and no job is running — the caller
  // must surface this as a hard failure, never as `split_pending` (code
  // review fix: `split_pending` here would have the wizard poll forever
  // against a job that doesn't exist).
  | { kind: 'split_enqueue_failed'; hashListId: number }
  // The caller passed `skipSplit: true` but the target list does NOT
  // verifiably resolve to a single classification group — see
  // `verifiesSingleGroup`'s doc comment. No campaign was created; the
  // caller must resolve the list through the normal split/review flow
  // instead of retrying with `skipSplit` (security fix — CodeRabbit).
  | { kind: 'skip_split_rejected'; hashListId: number; reason: string }

/**
 * Re-verifies that a mixed-flagged parent with no split children genuinely
 * resolves to a single CONFIDENT classification group, before
 * `createCampaignOrSplit` honors a client's `skipSplit: true` override
 * (security fix — CodeRabbit).
 *
 * Re-runs the SAME pure classifier (`planSplit`) the async split job uses,
 * against the list's CURRENT items, rather than trusting the parent's
 * persisted `type_analysis.verdict` — that verdict is exactly what
 * `skipSplit` is meant to override (it's stale-mixed after a
 * `degenerate-single-group` job run, which never updates it), so re-reading
 * it here would just re-trust the same flag the caller is trying to bypass.
 *
 * An empty list (zero groups) is safe to honor — there is nothing to crack
 * under a wrong mode either way. A sole group is safe ONLY when it is
 * CONFIDENT (bug fix — CodeRabbit, Major correctness): a sole AMBIGUOUS or
 * UNIDENTIFIED group also collapses `planSplit` to exactly one group, but
 * those hashes are NOT resolved to a mode — honoring `skipSplit` for them
 * would create a plain single-mode campaign over hashes that either need a
 * type declared (unidentified) or could be cracked under the wrong mode
 * (ambiguous). Both must be rejected and routed through the normal
 * split/review flow instead, even though there's technically "only one
 * group" to look at.
 */
async function verifiesSingleGroup(hashListId: number): Promise<boolean> {
  const itemRows = await db
    .select({ id: hashItems.id, hashValue: hashItems.hashValue })
    .from(hashItems)
    .where(eq(hashItems.hashListId, hashListId))

  const plan = planSplit(itemRows)
  if (plan.groups.length === 0) return true
  return plan.groups.length === 1 && plan.groups[0]?.kind === 'confident'
}

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

  const existingChildren = await db
    .select({ id: hashLists.id })
    .from(hashLists)
    .where(eq(hashLists.parentHashListId, targetList.id))
    .limit(1)

  if (input.skipSplit) {
    // Security fix (CodeRabbit, Major): `skipSplit` used to be honored
    // unconditionally on ANY mixed-verdict list, letting any client bypass
    // the split and crack a genuinely mixed list under one guessed mode.
    // `skipSplit` exists ONLY for the wizard's `single_group` fallback —
    // the async split job classified the list as `degenerate-single-group`
    // and created no children (see `queue/workers/hash-list-split.ts`), so
    // the parent's persisted `type_analysis.verdict` stays a stale
    // "mixed"/"needs-review" even though every item actually shares one
    // hashcat mode. Both branches below verify that stale-verdict story is
    // actually true before honoring the override, instead of trusting the
    // client's flag.
    if (existingChildren.length > 0) {
      // Real split children already exist, meaning `planSplit` genuinely
      // found 2+ groups when the async job ran (a single-group outcome
      // never creates children). `skipSplit` can never legitimately apply
      // here — reject rather than silently creating a wrong-mode campaign
      // on the (now-empty-of-items) parent list.
      return {
        kind: 'skip_split_rejected',
        hashListId: targetList.id,
        reason:
          'Hash list has already been split into multiple hash-type groups awaiting review; resolve them via the split review flow instead of skipSplit.',
      }
    }

    if (!(await verifiesSingleGroup(targetList.id))) {
      return {
        kind: 'skip_split_rejected',
        hashListId: targetList.id,
        reason:
          'Hash list still classifies into multiple hash-type groups; run the split flow instead of skipSplit.',
      }
    }

    return createCampaignWithAttacks(input)
  }

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
  //
  // Code review fix: the enqueue's success is no longer discarded. A
  // failed enqueue means there is no job for the status poll to ever find
  // — returning `split_pending` anyway would have the wizard poll
  // `GET /campaigns/split/status/{hashListId}` forever against a job that
  // was never created, with no error ever surfacing.
  const enqueued = await enqueueSplitJob(targetList.id, input.projectId)
  if (!enqueued) {
    return { kind: 'split_enqueue_failed', hashListId: targetList.id }
  }
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
 * Max `hash_items` rows loaded into memory per page while moving one KTD6
 * merge source's rows onto its target — mirrors `MOVE_BATCH_SIZE`
 * (`hash-items/move-items.ts`, itself the per-UPDATE chunk size).
 */
const MERGE_PAGE_SIZE = MOVE_BATCH_SIZE

/**
 * Moves every `hash_items` row currently on `sourceHashListId` onto
 * `targetHashListId`, stamping `detectedHashcatMode` to `mode` in the same
 * UPDATE. Pages by id ascending in `MERGE_PAGE_SIZE`-sized chunks instead of
 * SELECTing the whole source group's id list into memory before moving
 * anything (code review fix — the prior implementation materialized every
 * id of the group being merged in one query, defeating the point of
 * `moveHashItemsToList`'s own internal batching for a large group).
 *
 * No cursor/offset bookkeeping needed: each iteration re-queries
 * `WHERE hash_list_id = sourceHashListId ORDER BY id LIMIT MERGE_PAGE_SIZE`
 * against Postgres's CURRENT state, and `moveHashItemsToList` reassigns
 * every row in that page's `hash_list_id` away from `sourceHashListId`
 * before the next page is fetched — so a moved row can never reappear in a
 * later page, and the loop terminates in `ceil(rowCount / MERGE_PAGE_SIZE)`
 * round trips regardless of source size.
 *
 * Collision safety (`(hash_list_id, hash_value)` unique index): a hash list
 * can never contain a duplicate `hashValue` (ingestion's
 * `onConflictDoNothing`), and every KTD6 merge's source/target pair are
 * BOTH children of the same split parent — i.e. a strict partition of that
 * parent's items (`hash-items/split-analysis.ts`'s `planSplit` assigns each
 * parent item to exactly one group, deduping any same-`hashValue` collision
 * within a single destination group at plan time). Two children of the same
 * parent can therefore never share a `hashValue` with each other either, so
 * this move can never violate that unique index — the same invariant
 * `moveHashItemsToList`'s own doc comment already documents for this exact
 * caller, re-stated here since this is the function that actually calls it.
 */
async function mergeGroupIntoTarget(
  tx: Tx,
  sourceHashListId: number,
  targetHashListId: number,
  mode: number
): Promise<void> {
  for (;;) {
    const page = await tx
      .select({ id: hashItems.id })
      .from(hashItems)
      .where(eq(hashItems.hashListId, sourceHashListId))
      .orderBy(asc(hashItems.id))
      .limit(MERGE_PAGE_SIZE)

    if (page.length === 0) break

    await moveHashItemsToList(
      tx,
      page.map((r) => r.id),
      targetHashListId,
      mode
    )

    if (page.length < MERGE_PAGE_SIZE) break
  }
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

  // Code review fix (self-healing retries, tightened by a follow-up code
  // review fix below): a subListId that is no longer an ambiguous child —
  // because it was already resolved by a PRIOR run of this exact call —
  // used to hard-fail validation here, turning a legitimate retry (client
  // timeout after the server already committed, a crash between this
  // transaction and the sequential campaign creates that follow it) into a
  // PERMANENT 409: every retry re-submits the same assignments, and every
  // retry fails the same way, with no way to ever complete.
  //
  // The ONLY safe idempotent-retry case is: the child still exists, is
  // already homogeneous, and its resolved mode EXACTLY matches what this
  // assignment requests — that is unambiguous evidence THIS assignment was
  // already applied. Two things that look superficially similar are NOT
  // safe to treat as a no-op, and must be rejected instead (follow-up code
  // review fix — the original fix over-tolerated both):
  //   - The child doesn't exist at all. The ONLY thing that ever deletes a
  //     `hash_lists` child row is the KTD6 same-mode merge below, but a
  //     merged-away source's mode always survives on its TARGET sibling
  //     (which stays a valid, now-homogeneous child) — so a legitimate
  //     merge-retry never needs to re-match a deleted row. A miss here is
  //     therefore always a genuinely invalid subListId (client bug, stale
  //     id, or a tampered request), not an idempotent replay.
  //   - The child is already homogeneous but resolved to a DIFFERENT mode
  //     than requested. Silently accepting this as a no-op would mean a
  //     conflicting reassignment attempt is reported as success while
  //     actually being ignored — the caller has no way to learn its
  //     request didn't do what it asked.
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
    if (typeAnalysis?.verdict === 'homogeneous') {
      const resolvedMode = typeAnalysis.detectedModes[0]?.hashcatMode
      if (resolvedMode === assignment.mode) {
        // Idempotent retry: this exact assignment was already applied by a
        // prior committed run of this same call. Safe no-op — it is already
        // picked up by the `resolved` collection loop below via its own
        // stored mode.
        continue
      }
      return {
        kind: 'invalid_assignment',
        reason: `Sub-list ${assignment.subListId} is already resolved to mode ${resolvedMode}, which conflicts with the requested mode ${assignment.mode}`,
      }
    }

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

  // Bug fix (CodeRabbit, Major correctness): reject the confirm outright
  // when any AMBIGUOUS child was left unassigned, instead of silently
  // omitting it from `resolved` below and returning `confirmed` anyway. The
  // omit-and-succeed behavior left those hashes with no sub-campaign and no
  // signal to the caller that they were never resolved — the user believed
  // the split was fully handled when a genuinely ambiguous group still
  // needed a mode. This check runs BEFORE any mutation below, so a rejected
  // confirm leaves every child's `type_analysis` untouched (this callback
  // still commits its transaction on a non-throw return, so validation must
  // finish before the first write).
  //
  // Scoped to `kind === 'ambiguous'` only: an UNIDENTIFIED (needs-type)
  // child legitimately has no sub-campaign — there is no mode to assign,
  // only a hash-type declaration outside this flow — so it is fine for it
  // to fall through unassigned.
  const unresolvedAmbiguousIds: number[] = []
  for (const child of children) {
    const typeAnalysis = child.typeAnalysis
    if (typeAnalysis?.verdict !== 'needs-review') continue
    const isAmbiguous = typeAnalysis.detectedModes.length > 0
    if (isAmbiguous && !assignmentBySubListId.has(child.id)) {
      unresolvedAmbiguousIds.push(child.id)
    }
  }
  if (unresolvedAmbiguousIds.length > 0) {
    return {
      kind: 'invalid_assignment',
      reason: `Ambiguous sub-list(s) ${unresolvedAmbiguousIds.join(', ')} require a mode assignment before the split can be confirmed`,
    }
  }

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
      // Only an unidentified (needs-type) child can reach here — a still-
      // ambiguous unassigned child was already rejected above.
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
      await mergeGroupIntoTarget(tx, other.id, target!.id, mode)
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

  // Idempotency guard + self-healing backfill (code review fix, extends the
  // original P2 guard). `mergeResult.groups` is now ALWAYS the full,
  // current, resolved sub-list set for this parent — regardless of whether
  // this is the first-ever call or a retry, because `applyAssignmentsAndMerge`
  // above tolerates re-submitting already-applied assignments instead of
  // erroring. So `mergeResult.groups` is exactly "the expected sub-list
  // set" this function needs to have a campaign for.
  //
  // Detect a prior confirm by looking for the parent campaign this call
  // would otherwise create — a campaign already targeting
  // `parentHashListId` with no `parentCampaignId` of its own. Three cases:
  //   - No prior confirm: no existing parent campaign. Create the parent,
  //     then every sub-campaign in `mergeResult.groups`.
  //   - Prior confirm crashed before creating the parent (but after the
  //     merge transaction committed): same as above — `mergeResult.groups`
  //     reflects the already-resolved children, so this creates the parent
  //     + full sub-campaign set fresh, exactly once.
  //   - Prior confirm crashed partway through the sub-campaign loop (or
  //     completed fully): the parent campaign exists. BACKFILL only the
  //     `mergeResult.groups` entries that don't already have a
  //     `campaigns` row linked via `parentCampaignId` + `hashListId` —
  //     a fully-completed prior run backfills nothing (returns the
  //     existing set unchanged); a partial one completes it. Never
  //     re-creates a sub-campaign for a group that already has one, so
  //     `campaigns.hashListId` needing no unique constraint stays safe.
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

  const parentCampaign =
    existingParentCampaign ??
    (await createCampaign(
      {
        projectId: input.projectId,
        name: input.name,
        description: input.description,
        hashListId: input.parentHashListId,
        priority: input.priority,
        createdBy: input.createdBy,
      },
      input.actor
    ))
  if (!parentCampaign) {
    throw new Error('confirmSplitCampaign: parent campaign insert returned no row')
  }

  const existingSubCampaignRows = existingParentCampaign
    ? await db
        .select()
        .from(campaigns)
        .where(
          and(
            eq(campaigns.parentCampaignId, parentCampaign.id),
            eq(campaigns.projectId, input.projectId)
          )
        )
    : []
  // Keyed by the sub-list `hashListId` a sub-campaign targets — that's the
  // stable identity `mergeResult.groups` cross-references against, not the
  // sub-campaign's own id.
  const existingByHashListId = new Map(existingSubCampaignRows.map((sub) => [sub.hashListId, sub]))

  const subCampaigns: ResolvedSubCampaign[] = []
  for (const group of mergeResult.groups) {
    const existingSub = existingByHashListId.get(group.id)
    if (existingSub) {
      if (existingSub.hashcatMode === null) {
        // A sub-campaign created via this flow always latches hashcatMode
        // at insert time (see the createCampaign call below) — a null here
        // means the row was never actually created by confirmSplitCampaign,
        // so surface it loudly rather than shipping a bogus `mode: 0`.
        throw new Error(
          `confirmSplitCampaign: existing sub-campaign ${existingSub.id} has no hashcatMode`
        )
      }
      subCampaigns.push({
        id: existingSub.id,
        hashListId: group.id,
        mode: existingSub.hashcatMode,
        parentCampaignId: parentCampaign.id,
      })
      continue
    }

    // Not yet created (first-ever run, or backfilling what a partial prior
    // run left missing).
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
    if (!subCampaign) {
      // Mirrors the parent-campaign guard above (code review fix): a group
      // silently vanishing from the response because its insert raced to
      // no row is worse than a loud failure the caller can retry.
      throw new Error(
        `confirmSplitCampaign: sub-campaign insert for hash list ${group.id} returned no row`
      )
    }
    subCampaigns.push({
      id: subCampaign.id,
      hashListId: group.id,
      mode: group.mode,
      parentCampaignId: parentCampaign.id,
    })
  }

  return { kind: 'confirmed', parentCampaign, subCampaigns }
}
