/**
 * U(SU2/SU7) — Mixed hash-list split analysis worker.
 *
 * Partitions a mixed-verdict parent hash list's items into per-type
 * sub-lists (`hash_lists.parent_hash_list_id`) and moves the rows, per the
 * cross-unit contract pinned in `services/hash-items/split-analysis.ts`.
 *
 * Exported surface:
 *   - `runSplitAnalysis` — the testable DB core, and (as of SU7) the
 *     processor `createHashListSplitWorker` invokes for a real
 *     `HASH_LIST_SPLIT` job. `services/campaign-split.ts`'s
 *     `createCampaignOrSplit` no longer awaits it inline: on a first call
 *     against a mixed parent it enqueues the job (deduped per hash list via
 *     `splitJobId`) and returns immediately, and the wizard polls
 *     `GET /campaigns/split/status/{hashListId}`
 *     (`services/campaign-split-status.ts`) for the outcome. Real-DB tests
 *     still call `runSplitAnalysis` directly to simulate the worker running
 *     the job, the same way `processImportPairs` in `hash-import-worker.ts`
 *     does (the db test lane has no live Redis).
 *   - `createHashListSplitWorker` — the live BullMQ worker for
 *     `QUEUE_NAMES.HASH_LIST_SPLIT`, registered in `worker-jobs.ts`. Its
 *     processor returns the full `SplitResult` (not just void) so the
 *     job's `returnvalue` carries `outcome` — the status endpoint reads
 *     that `returnvalue` directly for the two degenerate outcomes, which
 *     leave no `hash_lists` children row to read instead.
 *
 * "Split in progress" tracking: there is no dedicated `hash_lists.status`
 * value for this (the `ResourceStatusLiteral` union is pinned and does not
 * get a new member for this feature). Instead:
 *   - In-flight is whatever the BullMQ job's own lifecycle says (queued /
 *     active / completed / failed) — the status endpoint reads the job via
 *     `QueueManager.getJobInfo`, not the resource row.
 *   - Idempotency / duplicate-job protection is guarded by data, not a
 *     status flag: `runSplitAnalysis` takes a `FOR UPDATE` row lock on the
 *     parent, then checks whether it already has children. A second call
 *     (retry, duplicate enqueue, concurrent trigger) serializes behind the
 *     lock and finds the children already there, so it is a pure no-op
 *     (`outcome: 'already-split'`) — it can never double-split. BullMQ's
 *     own jobId dedup (`splitJobId`) prevents a second job from even being
 *     enqueued for the same parent while one is outstanding.
 *
 * `runSplitAnalysis` two-phase design (code review fix — perf/lock
 * duration): a large parent list's items are never loaded into memory in
 * one shot, and the parent row's `FOR UPDATE` lock is not held for the
 * classification scan.
 *   1. `classifyParentItems` keyset-pages `hash_items` by id
 *      (`SPLIT_CLASSIFY_CHUNK_SIZE` rows at a time, OUTSIDE any lock) and
 *      calls the pure `planSplit` per chunk, merging each chunk's groups
 *      into a running `kind`/`mode`/`signature`-keyed accumulator
 *      (`mergeChunkGroups`). Cross-chunk merge is a plain concat, not a
 *      re-dedup pass — safe because `(hash_list_id, hash_value)` is unique
 *      at the DB level (ingestion's `onConflictDoNothing`, see
 *      `split-analysis.ts`'s cross-unit contract), so the same `hashValue`
 *      can never appear in two different chunks of the same parent.
 *   2. The transaction below then takes the `FOR UPDATE` lock ONLY for the
 *      idempotency check (already-split no-op) and the final commit
 *      (degenerate-outcome marker write, or the sub-list create + item
 *      move) — the comparatively slow classification scan happens before
 *      the lock is ever acquired.
 *   Residual risk (documented, not new): if `hash_items` rows for this
 *   parent are inserted/deleted between phase 1 and phase 2, phase 2
 *   commits against a stale item set. This was already possible in the
 *   single-phase version — the original `FOR UPDATE` locked only the
 *   `hash_lists` row, never the child `hash_items` rows, so concurrent
 *   item mutation was never actually serialized against the split. The
 *   window is wider now (phase 1 can take longer for a very large list),
 *   but a hash list is expected to be `ready` (post-ingestion, stable)
 *   before a split is ever triggered, so this is a low-probability,
 *   pre-existing class of risk, not a newly introduced correctness bug.
 */

import type { HashListTypeAnalysis } from '@hashhive/shared'
import type Redis from 'ioredis'

import { hashItems, hashLists } from '@hashhive/shared'
import { type ConnectionOptions, Worker } from 'bullmq'
import { and, asc, count, eq, gt, inArray } from 'drizzle-orm'

import type { SplitDegenerateReason, SplitGroup } from '../../services/hash-items/split-analysis.js'
import type { HashListSplitJob } from '../types.js'

import { logger } from '../../config/logger.js'
import { QUEUE_NAMES } from '../../config/queue.js'
import { db } from '../../db/index.js'
import { moveHashItemsToList } from '../../services/hash-items/move-items.js'
import { planSplit } from '../../services/hash-items/split-analysis.js'
import { attachWorkerMetrics } from './metrics.js'

// ─── Constants ────────────────────────────────────────────────────────────

/** `hash_lists.name` is `varchar(255)` — guard the generated sub-list name. */
const MAX_SUB_LIST_NAME_LENGTH = 255

/**
 * Row count per keyset-paged classification chunk (code review fix —
 * perf/lock-duration). Bounds how many `hash_items` rows (each carrying a
 * `hash_value` up to 1024 chars) are held in memory at once during
 * classification, instead of loading the parent's entire item set into one
 * array. Not tuned against a benchmark (no perf tests in this repo's CI) —
 * picked as a conservative middle ground between round-trip overhead (too
 * small) and defeating the memory bound this exists for (too large).
 */
const SPLIT_CLASSIFY_CHUNK_SIZE = 5_000

// ─── Types ────────────────────────────────────────────────────────────────

export type SplitOutcome =
  | 'split'
  | 'degenerate-empty'
  | 'degenerate-single-group'
  | 'already-split'

/**
 * Summary of one created (or reconstructed) sub-list. Discriminated on
 * `kind` — mirrors `SplitGroup`: `mode` exists only for `confident` (the
 * one case where a single hashcat mode is known), not on `ambiguous` /
 * `unidentified`.
 */
export type SplitSubList =
  | { id: number; kind: 'confident'; mode: number; itemCount: number }
  | { id: number; kind: 'ambiguous' | 'unidentified'; itemCount: number }

/**
 * Result of a split-analysis run — the contract SU3 consumes to decide
 * whether a real split happened (route the campaign wizard through the
 * sub-lists) or the caller should fall back to a plain campaign
 * (`degenerate-empty` / `degenerate-single-group`), or nothing changed
 * because a prior run already split this parent (`already-split`).
 */
export interface SplitResult {
  parentHashListId: number
  outcome: SplitOutcome
  subLists: SplitSubList[]
}

// Drizzle transaction handle — the callback argument type of `db.transaction`.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

// ─── Naming / type-analysis builders ────────────────────────────────────────

function buildSubListName(parentName: string, group: SplitGroup): string {
  let suffix: string
  if (group.kind === 'confident') {
    suffix = `mode ${group.mode}`
  } else if (group.kind === 'ambiguous') {
    suffix = `ambiguous (${group.candidateModes.join(', ')})`
  } else {
    suffix = 'unidentified'
  }
  const name = `${parentName} - ${suffix}`
  return name.length > MAX_SUB_LIST_NAME_LENGTH ? name.slice(0, MAX_SUB_LIST_NAME_LENGTH) : name
}

/**
 * Builds the sub-list's `type_analysis` per the cross-unit contract:
 *   - confident   -> homogeneous, one detected mode covering every item
 *   - ambiguous   -> needs-review, every candidate mode listed (each
 *                    covering the full item count — the ambiguity is
 *                    per-item, not a per-mode split of the count)
 *   - unidentified -> needs-review, empty detectedModes, unidentifiedCount
 *                    set to the group's item count
 */
function buildGroupTypeAnalysis(group: SplitGroup, itemCount: number): HashListTypeAnalysis {
  const analyzedAt = new Date().toISOString()

  if (group.kind === 'confident') {
    return {
      verdict: 'homogeneous',
      detectedModes: [{ hashcatMode: group.mode, count: itemCount }],
      unidentifiedCount: 0,
      scannedCount: itemCount,
      sampled: false,
      declaredMode: null,
      analyzedAt,
    }
  }

  if (group.kind === 'ambiguous') {
    return {
      verdict: 'needs-review',
      detectedModes: group.candidateModes.map((hashcatMode) => ({ hashcatMode, count: itemCount })),
      unidentifiedCount: 0,
      scannedCount: itemCount,
      sampled: false,
      declaredMode: null,
      analyzedAt,
    }
  }

  return {
    verdict: 'needs-review',
    detectedModes: [],
    unidentifiedCount: itemCount,
    scannedCount: itemCount,
    sampled: false,
    declaredMode: null,
    analyzedAt,
  }
}

function buildStatistics(
  itemIds: readonly number[],
  crackedById: ReadonlyMap<number, boolean>
): { totalCount: number; crackedCount: number; crackRate: number; lastUpdated: string } {
  const totalCount = itemIds.length
  const crackedCount = itemIds.filter((id) => crackedById.get(id) === true).length
  return {
    totalCount,
    crackedCount,
    crackRate: totalCount > 0 ? crackedCount / totalCount : 0,
    lastUpdated: new Date().toISOString(),
  }
}

/**
 * Reconstructs a `SplitSubList` summary for an already-split parent's
 * existing children — used only for the `already-split` idempotent-replay
 * outcome, so a caller re-driving the job (or SU3 polling) still gets a
 * usable summary instead of an empty array.
 */
async function summarizeExistingChildren(
  tx: Tx,
  children: ReadonlyArray<{ id: number; typeAnalysis: HashListTypeAnalysis | null }>
): Promise<SplitSubList[]> {
  const childIds = children.map((c) => c.id)
  const counts = await tx
    .select({ hashListId: hashItems.hashListId, total: count() })
    .from(hashItems)
    .where(inArray(hashItems.hashListId, childIds))
    .groupBy(hashItems.hashListId)
  const countByListId = new Map(counts.map((c) => [c.hashListId, Number(c.total)]))

  return children.map((child): SplitSubList => {
    const typeAnalysis = child.typeAnalysis
    const itemCount = countByListId.get(child.id) ?? 0
    const detectedMode = typeAnalysis?.detectedModes[0]?.hashcatMode

    // A homogeneous verdict always carries exactly one detectedModes entry
    // (see buildGroupTypeAnalysis's confident branch), so `detectedMode` is
    // defined whenever verdict === 'homogeneous' for any row this function
    // actually persisted. The `undefined` guard exists only so the return
    // type stays sound against arbitrary persisted data rather than
    // asserting an invariant with a throw.
    if (typeAnalysis?.verdict === 'homogeneous' && detectedMode !== undefined) {
      return { id: child.id, kind: 'confident', mode: detectedMode, itemCount }
    }

    const kind: 'ambiguous' | 'unidentified' =
      (typeAnalysis?.detectedModes.length ?? 0) > 0 ? 'ambiguous' : 'unidentified'
    return { id: child.id, kind, itemCount }
  })
}

// ─── Chunked classification (phase 1 — outside any lock) ──────────────────

/** Stable merge key for a `SplitGroup` — mirrors `split-analysis.ts`'s
 * private `groupKey`, which is not exported (that module has no DB
 * dependency and stays that way); duplicated here rather than widening its
 * exported surface for one caller. */
function splitGroupKey(group: SplitGroup): string {
  if (group.kind === 'confident') return `confident:${group.mode}`
  if (group.kind === 'ambiguous') return `ambiguous:${group.candidateModes.join(',')}`
  return 'unidentified'
}

/**
 * Merges one chunk's `planSplit` groups into the running accumulator,
 * MUTATING `merged` in place. This is a deliberate exception to the
 * project's immutable-update convention: `merged` is a function-local
 * accumulator (never shared, never read by a caller mid-loop), and
 * rebuilding a new `itemIds` array on every chunk (`[...existing, ...new]`)
 * would make merging O(total items already accumulated) per chunk instead
 * of O(chunk size) — quadratic in the number of chunks, which would defeat
 * the whole point of this fix (perf/memory). Safe to concat without a
 * cross-chunk hashValue re-dedup: see the file header doc comment.
 */
function mergeChunkGroups(
  merged: Map<string, SplitGroup>,
  chunkGroups: readonly SplitGroup[]
): void {
  for (const group of chunkGroups) {
    const key = splitGroupKey(group)
    const existing = merged.get(key)
    if (!existing) {
      merged.set(key, { ...group, itemIds: [...group.itemIds] })
      continue
    }
    existing.itemIds.push(...group.itemIds)
  }
}

interface ClassificationResult {
  totalCount: number
  groups: Map<string, SplitGroup>
  crackedById: Map<number, boolean>
}

/**
 * Keyset-pages `hash_items` for `parentHashListId` in
 * `SPLIT_CLASSIFY_CHUNK_SIZE`-row chunks (ordered by `id`, no `FOR UPDATE`
 * — see the file header doc comment) and classifies each chunk with the
 * pure `planSplit`, merging results incrementally. No `tx` argument
 * deliberately: this phase runs before the transaction that holds the row
 * lock, on the shared `db` client.
 */
async function classifyParentItems(parentHashListId: number): Promise<ClassificationResult> {
  const groups = new Map<string, SplitGroup>()
  const crackedById = new Map<number, boolean>()
  let totalCount = 0
  let afterId = 0

  for (;;) {
    const chunk = await db
      .select({ id: hashItems.id, hashValue: hashItems.hashValue, crackedAt: hashItems.crackedAt })
      .from(hashItems)
      .where(and(eq(hashItems.hashListId, parentHashListId), gt(hashItems.id, afterId)))
      .orderBy(asc(hashItems.id))
      .limit(SPLIT_CLASSIFY_CHUNK_SIZE)

    if (chunk.length === 0) break

    for (const row of chunk) {
      crackedById.set(row.id, row.crackedAt !== null)
    }
    totalCount += chunk.length

    const chunkPlan = planSplit(chunk.map((r) => ({ id: r.id, hashValue: r.hashValue })))
    mergeChunkGroups(groups, chunkPlan.groups)

    if (chunk.length < SPLIT_CLASSIFY_CHUNK_SIZE) break
    afterId = chunk[chunk.length - 1]!.id
  }

  return { totalCount, groups, crackedById }
}

/**
 * Mirrors `planSplit`'s degenerate-outcome rule, computed over the FULL
 * (merged, cross-chunk) partition rather than any single chunk.
 *
 * Bug fix (CodeRabbit, Major correctness): a sole group used to be treated
 * as `single-group` regardless of its `kind`. A list that is entirely
 * AMBIGUOUS (e.g. every item is a 32-hex string — NTLM/MD5/LM/MD4 all
 * collide) or entirely UNIDENTIFIED also collapses to exactly one group, but
 * that group is NOT confidently resolved to a mode — collapsing it to
 * "nothing to split" let `createCampaignOrSplit`'s `skipSplit` fallback
 * create a plain single-mode campaign under a wrong/no mode instead of
 * routing the list through the split/review flow. Only a sole CONFIDENT
 * group (every item genuinely shares one hashcat mode) is a legitimate
 * degenerate single-group fallback; a sole ambiguous/unidentified group
 * falls through to `null` here so the normal split path below creates a
 * one-child sub-list the review flow can present for assignment.
 */
function degenerateOutcomeFor(classification: ClassificationResult): SplitDegenerateReason {
  if (classification.totalCount === 0) return 'empty'
  if (classification.groups.size === 1) {
    const [soleGroup] = classification.groups.values()
    if (soleGroup?.kind === 'confident') return 'single-group'
  }
  return null
}

/** Deterministic sub-list creation order: confident, then ambiguous, then
 * unidentified — mirrors `split-analysis.ts`'s private `compareGroups`,
 * duplicated here for the same reason as `splitGroupKey` above. */
const SPLIT_GROUP_KIND_ORDER: Record<SplitGroup['kind'], number> = {
  confident: 0,
  ambiguous: 1,
  unidentified: 2,
}

function compareSplitGroups(a: SplitGroup, b: SplitGroup): number {
  const kindDiff = SPLIT_GROUP_KIND_ORDER[a.kind] - SPLIT_GROUP_KIND_ORDER[b.kind]
  if (kindDiff !== 0) return kindDiff

  if (a.kind === 'confident' && b.kind === 'confident') {
    return a.mode - b.mode
  }

  if (a.kind === 'ambiguous' && b.kind === 'ambiguous') {
    const maxLen = Math.max(a.candidateModes.length, b.candidateModes.length)
    for (let i = 0; i < maxLen; i++) {
      const diff = (a.candidateModes[i] ?? 0) - (b.candidateModes[i] ?? 0)
      if (diff !== 0) return diff
    }
    return 0
  }

  return 0
}

/**
 * Persists the durable degenerate-outcome marker (code review fix — see
 * `resources.ts`'s `hashListStatisticsSchema.splitOutcome` doc comment)
 * into the parent's `statistics` jsonb, preserving whatever fields are
 * already there (e.g. a prior parse's `totalCount`/`crackedCount`). Called
 * only from inside the locked transaction, alongside the degenerate
 * `SplitResult` return.
 */
async function persistDegenerateSplitOutcome(
  tx: Tx,
  parent: { id: number; statistics: unknown },
  splitOutcome: 'empty' | 'single_group'
): Promise<void> {
  const existingStats =
    typeof parent.statistics === 'object' && parent.statistics !== null ? parent.statistics : {}
  await tx
    .update(hashLists)
    .set({ statistics: { ...existingStats, splitOutcome } })
    .where(eq(hashLists.id, parent.id))
}

// ─── Core processor ───────────────────────────────────────────────────────

/**
 * Runs split analysis for a parent hash list and, on a real split, creates
 * the per-type sub-lists and moves items into them transactionally.
 *
 * Exported for real-DB testing — the DB test suite calls this directly with
 * a seeded parent + items, bypassing Redis entirely.
 */
export async function runSplitAnalysis(parentHashListId: number): Promise<SplitResult> {
  // Phase 1 — classify OUTSIDE any lock (see the file header doc comment).
  const classification = await classifyParentItems(parentHashListId)
  const degenerate = degenerateOutcomeFor(classification)

  // Phase 2 — lock the parent row only for the idempotency check and the
  // final commit.
  return db.transaction(async (tx) => {
    // Row lock on the parent serializes concurrent/duplicate split attempts
    // for the SAME parent — the children-existence check below is then
    // race-safe: whichever transaction commits first "wins" the split, and
    // any transaction that was waiting on the lock sees the children once
    // it proceeds.
    const [parent] = await tx
      .select()
      .from(hashLists)
      .where(eq(hashLists.id, parentHashListId))
      .for('update')
      .limit(1)

    if (!parent) {
      throw new Error(`Hash list ${parentHashListId} not found`)
    }

    const existingChildren = await tx
      .select({ id: hashLists.id, typeAnalysis: hashLists.typeAnalysis })
      .from(hashLists)
      .where(eq(hashLists.parentHashListId, parentHashListId))

    if (existingChildren.length > 0) {
      const subLists = await summarizeExistingChildren(tx, existingChildren)
      logger.info(
        { parentHashListId, subListCount: subLists.length },
        'hash-list-split: parent already split, no-op'
      )
      return { parentHashListId, outcome: 'already-split', subLists }
    }

    if (degenerate === 'empty') {
      await persistDegenerateSplitOutcome(tx, parent, 'empty')
      logger.info({ parentHashListId }, 'hash-list-split: parent has no items, skipping')
      return { parentHashListId, outcome: 'degenerate-empty', subLists: [] }
    }
    if (degenerate === 'single-group') {
      await persistDegenerateSplitOutcome(tx, parent, 'single_group')
      logger.info(
        { parentHashListId },
        'hash-list-split: parent classifies as a single group, skipping'
      )
      return { parentHashListId, outcome: 'degenerate-single-group', subLists: [] }
    }

    const orderedGroups = [...classification.groups.values()].sort(compareSplitGroups)
    const createdSubLists: SplitSubList[] = []

    for (const group of orderedGroups) {
      const [subList] = await tx
        .insert(hashLists)
        .values({
          projectId: parent.projectId,
          parentHashListId,
          name: buildSubListName(parent.name, group),
          status: 'ready',
          statistics: buildStatistics(group.itemIds, classification.crackedById),
          typeAnalysis: buildGroupTypeAnalysis(group, group.itemIds.length),
        })
        .returning({ id: hashLists.id })

      const subListId = subList!.id

      await moveHashItemsToList(
        tx,
        group.itemIds,
        subListId,
        group.kind === 'confident' ? group.mode : undefined
      )

      createdSubLists.push(
        group.kind === 'confident'
          ? { id: subListId, kind: 'confident', mode: group.mode, itemCount: group.itemIds.length }
          : { id: subListId, kind: group.kind, itemCount: group.itemIds.length }
      )
    }

    logger.info(
      { parentHashListId, subListCount: createdSubLists.length },
      'hash-list-split: split complete'
    )

    return { parentHashListId, outcome: 'split', subLists: createdSubLists }
  })
}

// ─── Worker factory ───────────────────────────────────────────────────────

export function createHashListSplitWorker(connection: Redis): Worker<HashListSplitJob> {
  const worker = new Worker<HashListSplitJob>(
    QUEUE_NAMES.HASH_LIST_SPLIT,
    async (job) => {
      const { hashListId } = job.data
      logger.info({ jobId: job.id, hashListId }, 'hash-list-split: starting')
      const result = await runSplitAnalysis(hashListId)
      logger.info(
        { hashListId, outcome: result.outcome, subListCount: result.subLists.length },
        'hash-list-split: complete'
      )
      return result
    },
    // Cast needed: our ioredis version may differ from BullMQ's bundled ioredis types
    { connection: connection as unknown as ConnectionOptions }
  )

  attachWorkerMetrics(worker, {
    queueName: QUEUE_NAMES.HASH_LIST_SPLIT,
    failureMessage: 'Hash list split analysis failed',
    extractContext: (job) => ({ hashListId: job?.data?.hashListId }),
  })

  return worker
}
