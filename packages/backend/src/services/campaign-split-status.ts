/**
 * Async split-status polling (issue #202 SU7).
 *
 * `createCampaignOrSplit` (`services/campaign-split.ts`) enqueues the
 * `HASH_LIST_SPLIT` job and returns immediately instead of awaiting
 * `runSplitAnalysis` inline. The wizard polls
 * `GET /campaigns/split/status/{hashListId}` (backed by `getSplitStatus`
 * below) until the job resolves. Two signals are read, in this order:
 *
 *   1. Does the parent now have children? A real split (`runSplitAnalysis`
 *      outcome `split` / `already-split`) creates `hash_lists` rows with
 *      `parent_hash_list_id` set — this is checked first because it is the
 *      durable, authoritative signal and survives job eviction.
 *   2. Otherwise, the BullMQ job itself (`splitJobId(hashListId)`) is the
 *      only signal for the two degenerate outcomes, which leave no
 *      children row: `degenerate-empty` (`status: 'empty'`) and
 *      `degenerate-single-group` (`status: 'single_group'`), plus a
 *      genuine job failure (`status: 'failed'`). `deriveSplitStatus` is the
 *      pure decision function — factored out so it's testable without a
 *      DB or a live Redis (see `tests/unit/services/split-status.test.ts`).
 */
import type { SplitStatusResponse } from '@hashhive/shared'

import { hashLists } from '@hashhive/shared'
import { eq } from 'drizzle-orm'

import type { QueueJobInfo } from '../queue/manager.js'
import type { SplitOutcome } from '../queue/workers/hash-list-split.js'

import { logger } from '../config/logger.js'
import { db } from '../db/index.js'
import { _campaignSplitDeps, getSplitReviewGroups, splitJobId } from './campaign-split.js'
import { getHashListById } from './resources.js'

export type SplitStatusLiteral = SplitStatusResponse['status']

/**
 * Best-effort read of the split job's terminal state via the QueueManager.
 * Mirrors `enqueueSplitJob`'s dynamic-import seam and never-throw contract
 * (`services/campaign-split.ts`) — a missing queue manager or a lookup
 * throw both collapse to `null`, which `deriveSplitStatus` treats as
 * "no signal yet" (`pending`).
 */
async function getSplitJobInfo(hashListId: number): Promise<QueueJobInfo | null> {
  try {
    const { getQueueManager } = await _campaignSplitDeps.getQueueContext()
    const { QUEUE_NAMES } = await _campaignSplitDeps.getQueueConfig()
    const qm = getQueueManager()
    if (!qm) return null
    return await qm.getJobInfo(QUEUE_NAMES.HASH_LIST_SPLIT, splitJobId(hashListId))
  } catch (err) {
    logger.warn({ err, hashListId }, 'failed to read hash-list-split job state')
    return null
  }
}

/**
 * Maps a failed split job's `failedReason` to an operator-facing string
 * safe to return to the dashboard client. `failedReason` is BullMQ's copy
 * of the raw thrown `Error.message` — for `runSplitAnalysis`
 * (`queue/workers/hash-list-split.ts`) that can be Postgres/Drizzle text
 * embedding SQL, table, and column names, which must never round-trip
 * straight into the wizard's error banner (code review fix). Mirrors
 * `sanitizeParseError` in `queue/workers/hash-list-parser.ts` — same
 * rationale, same "stable enum of operator-meaningful reasons, default
 * generic" shape — but not shared with it directly: the two workers throw
 * different failure vocabularies (parser: missing/empty upload; split:
 * missing hash list / a malformed confident group), so a shared mapper
 * would have to guess which worker's message it's looking at.
 */
export function sanitizeSplitError(failedReason: string | null): string {
  if (!failedReason) return 'Split analysis failed'
  const msg = failedReason.toLowerCase()
  // Anchored "hash list" prefix avoids collapsing Postgres "relation ...
  // not found" / Redis "key not found" / generic "not found" errors into
  // a misleading "Hash list not found" wire message (mirrors
  // sanitizeParseError's same anchor for the same reason).
  if (/\bhash list .* not found\b/i.test(failedReason)) {
    return 'Hash list not found'
  }
  if (msg.includes('timeout') || msg.includes('econnrefused') || msg.includes('etimedout')) {
    return 'Storage backend unavailable'
  }
  // Default — never leak the raw SQL/internal message to the wire. Covers
  // e.g. `runSplitAnalysis`'s "confident group is missing a hashcat mode"
  // internal-invariant failure, which is meaningful to an operator reading
  // server logs but not to the dashboard client.
  return 'Split analysis failed'
}

function extractSplitOutcome(returnvalue: unknown): SplitOutcome | null {
  if (
    returnvalue !== null &&
    typeof returnvalue === 'object' &&
    'outcome' in returnvalue &&
    typeof (returnvalue as { outcome: unknown }).outcome === 'string'
  ) {
    const outcome = (returnvalue as { outcome: string }).outcome
    if (
      outcome === 'split' ||
      outcome === 'already-split' ||
      outcome === 'degenerate-empty' ||
      outcome === 'degenerate-single-group'
    ) {
      return outcome
    }
  }
  return null
}

/**
 * Pure decision function — no DB, no Redis. `hasChildren` is the
 * caller's already-fetched, authoritative signal; `jobInfo` is only
 * consulted when `hasChildren` is false.
 */
export function deriveSplitStatus(
  hasChildren: boolean,
  jobInfo: QueueJobInfo | null
): { status: SplitStatusLiteral; message: string | null } {
  if (hasChildren) {
    return { status: 'ready', message: null }
  }

  if (!jobInfo) {
    // Never enqueued yet, still queued, or already evicted past its
    // retention window with no children to show for it — all read the
    // same as "keep polling".
    return { status: 'pending', message: null }
  }

  if (jobInfo.state === 'failed') {
    // The raw `failedReason` is deliberately NOT included in this return
    // value — only the sanitized string reaches the dashboard client.
    // Callers that want the raw reason for server-side diagnostics read
    // `jobInfo.failedReason` directly (see `getSplitStatus`'s log call).
    return { status: 'failed', message: sanitizeSplitError(jobInfo.failedReason) }
  }

  if (jobInfo.state === 'completed') {
    const outcome = extractSplitOutcome(jobInfo.returnvalue)
    if (outcome === 'degenerate-empty') {
      return { status: 'empty', message: 'Hash list has no crackable items to split' }
    }
    if (outcome === 'degenerate-single-group') {
      return { status: 'single_group', message: null }
    }
    // outcome is 'split' / 'already-split' / unrecognized, but `hasChildren`
    // was false — either a race between the job settling and our children
    // read (the next poll will see the committed rows), or a shape we
    // don't recognize. Either way, fabricating `ready` with no review
    // groups would be worse than one more poll — stay `pending`.
    return { status: 'pending', message: null }
  }

  // active / waiting / delayed / waiting-children / paused / unknown
  return { status: 'pending', message: null }
}

export type GetSplitStatusResult =
  | { kind: 'not_found' }
  | { kind: 'ok'; response: SplitStatusResponse }

/**
 * Ownership-checks `hashListId` against the caller's project (mirrors the
 * `getHashListById(id, projectId)` guard used across the resources/results
 * routes), then resolves the current split status per `deriveSplitStatus`.
 */
export async function getSplitStatus(
  hashListId: number,
  projectId: number
): Promise<GetSplitStatusResult> {
  const target = await getHashListById(hashListId, projectId)
  if (!target) {
    return { kind: 'not_found' }
  }

  const children = await db
    .select({ id: hashLists.id })
    .from(hashLists)
    .where(eq(hashLists.parentHashListId, hashListId))
    .limit(1)
  const hasChildren = children.length > 0

  const jobInfo = hasChildren ? null : await getSplitJobInfo(hashListId)
  const { status, message } = deriveSplitStatus(hasChildren, jobInfo)

  if (jobInfo?.state === 'failed') {
    // Server-side-only log of the RAW failure reason (code review fix) —
    // `message` above is already sanitized for the wire; the raw
    // Postgres/Drizzle text an operator needs to actually debug the
    // failure only ever reaches the log, never the dashboard client.
    logger.warn({ hashListId, rawReason: jobInfo.failedReason }, 'hash-list-split job failed')
  }

  // `SplitStatusResponse` is a discriminated union keyed on `status`
  // (code review fix): `reviewGroups` is required and non-null on the
  // `ready` branch, and `null` on every other branch — never a flat
  // "any status, nullable reviewGroups" shape a caller has to
  // defensively re-check. Building the object inline (rather than a flat
  // `{ status, reviewGroups, message }`) is what lets TypeScript actually
  // verify that correlation against the discriminated union type.
  if (status === 'ready') {
    const reviewGroups = await getSplitReviewGroups(hashListId)
    return { kind: 'ok', response: { status: 'ready', reviewGroups, message } }
  }
  return { kind: 'ok', response: { status, reviewGroups: null, message } }
}
