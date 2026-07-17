/**
 * U(SU2) — Mixed hash-list split analysis worker.
 *
 * Partitions a mixed-verdict parent hash list's items into per-type
 * sub-lists (`hash_lists.parent_hash_list_id`) and moves the rows, per the
 * cross-unit contract pinned in `services/hash-items/split-analysis.ts`.
 *
 * Exported surface:
 *   - `runSplitAnalysis` — the testable DB core. As of SU3
 *     (`services/campaign-split.ts`'s `createCampaignOrSplit`), this is
 *     the ONLY way it currently runs: it is awaited SYNCHRONOUSLY inside
 *     the `POST /dashboard/campaigns` request path, not dispatched through
 *     BullMQ. Real-DB tests call it directly for the same reason
 *     `processImportPairs` in `hash-import-worker.ts` does (the db test
 *     lane has no live Redis).
 *   - `createHashListSplitWorker` — thin BullMQ factory wrapping the core,
 *     registered on `QUEUE_NAMES.HASH_LIST_SPLIT` for a future
 *     async-dispatch path (large parents deferred off the request path).
 *     Nothing calls `queue.add()` for this queue yet, so the worker is
 *     live but currently never receives a job — see the queue name's doc
 *     comment in `config/queue.ts`.
 *
 * "Split in progress" tracking: there is no dedicated `hash_lists.status`
 * value for this (the `ResourceStatusLiteral` union is pinned and does not
 * get a new member for this feature). Instead:
 *   - In-flight is whatever the BullMQ job's own lifecycle says (queued /
 *     active / completed / failed) — callers that need a live progress
 *     signal read the job, not the resource row.
 *   - Idempotency / duplicate-job protection is guarded by data, not a
 *     status flag: `runSplitAnalysis` takes a `FOR UPDATE` row lock on the
 *     parent, then checks whether it already has children. A second call
 *     (retry, duplicate enqueue, concurrent trigger) serializes behind the
 *     lock and finds the children already there, so it is a pure no-op
 *     (`outcome: 'already-split'`) — it can never double-split.
 */

import type { HashListTypeAnalysis } from '@hashhive/shared'
import type Redis from 'ioredis'

import { hashItems, hashLists } from '@hashhive/shared'
import { type ConnectionOptions, Worker } from 'bullmq'
import { count, eq, inArray } from 'drizzle-orm'

import type { SplitGroup } from '../../services/hash-items/split-analysis.js'
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

// ─── Types ────────────────────────────────────────────────────────────────

export type SplitOutcome =
  | 'split'
  | 'degenerate-empty'
  | 'degenerate-single-group'
  | 'already-split'

export interface SplitSubList {
  id: number
  kind: SplitGroup['kind']
  mode: number | null
  itemCount: number
}

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
    suffix = `ambiguous (${(group.candidateModes ?? []).join(', ')})`
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
    if (group.mode === undefined) {
      throw new Error('split-worker: confident group is missing a hashcat mode')
    }
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
    const candidateModes = group.candidateModes ?? []
    return {
      verdict: 'needs-review',
      detectedModes: candidateModes.map((hashcatMode) => ({ hashcatMode, count: itemCount })),
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

  return children.map((child) => {
    const typeAnalysis = child.typeAnalysis
    const kind: SplitGroup['kind'] =
      typeAnalysis?.verdict === 'homogeneous'
        ? 'confident'
        : (typeAnalysis?.detectedModes.length ?? 0) > 0
          ? 'ambiguous'
          : 'unidentified'
    const mode = kind === 'confident' ? (typeAnalysis?.detectedModes[0]?.hashcatMode ?? null) : null
    return {
      id: child.id,
      kind,
      mode,
      itemCount: countByListId.get(child.id) ?? 0,
    }
  })
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

    const itemRows = await tx
      .select({ id: hashItems.id, hashValue: hashItems.hashValue, crackedAt: hashItems.crackedAt })
      .from(hashItems)
      .where(eq(hashItems.hashListId, parentHashListId))

    const plan = planSplit(itemRows.map((r) => ({ id: r.id, hashValue: r.hashValue })))

    if (plan.degenerate === 'empty') {
      logger.info({ parentHashListId }, 'hash-list-split: parent has no items, skipping')
      return { parentHashListId, outcome: 'degenerate-empty', subLists: [] }
    }
    if (plan.degenerate === 'single-group') {
      logger.info(
        { parentHashListId },
        'hash-list-split: parent classifies as a single group, skipping'
      )
      return { parentHashListId, outcome: 'degenerate-single-group', subLists: [] }
    }

    const crackedById = new Map(itemRows.map((r) => [r.id, r.crackedAt !== null]))
    const createdSubLists: SplitSubList[] = []

    for (const group of plan.groups) {
      const [subList] = await tx
        .insert(hashLists)
        .values({
          projectId: parent.projectId,
          parentHashListId,
          name: buildSubListName(parent.name, group),
          status: 'ready',
          statistics: buildStatistics(group.itemIds, crackedById),
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

      createdSubLists.push({
        id: subListId,
        kind: group.kind,
        mode: group.mode ?? null,
        itemCount: group.itemIds.length,
      })
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
