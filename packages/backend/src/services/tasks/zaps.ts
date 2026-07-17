/**
 * Cracked-hash "zap" lookup for an agent's task.
 *
 * Pulled from `services/tasks.ts` to bring the parent service under the
 * per-file size budget. Owns the single endpoint agents call to fetch
 * hashes that have already been cracked by any campaign sharing the
 * same hash list, so they can skip work they would otherwise duplicate.
 *
 * Re-exported from `services/tasks.ts` so the agent route
 * (`routes/agent/index.ts -> getZapsForTask`) sees no change in its
 * import path.
 */
import { campaigns, hashItems, tasks } from '@hashhive/shared'
import { and, eq, gt, gte, inArray, isNotNull, or, type SQL } from 'drizzle-orm'

import { db } from '../../db/index.js'
import { resolveHashListScope } from '../hash-items/list-scope.js'
import { encodeZapCursor, type ZapCursor } from './zap-cursor.js'

/**
 * Hard ceiling on the number of zap rows returned per request.
 * Caller-supplied limits above this are clamped down; below 1 are
 * clamped up. This is the *only* bound between an agent's polling
 * query and the SQL planner, so a malformed or hostile agent can't
 * force a large in-memory read.
 *
 * Exported so the agent route's `zapQuerySchema` bounds `limit` against
 * the same value — one source of truth, so the route's boundary reject
 * and the service's clamp can't drift apart.
 */
export const MAX_ZAPS_LIMIT = 10_000

/**
 * Returns "zaps" — hashes already cracked by any campaign sharing this
 * task's hash list — so the calling agent can skip them. Project-scoped
 * via the campaigns join so a leaked task id from another project
 * resolves to "task not found", not a cross-project read.
 *
 * Pagination is an opaque composite cursor over `(crackedAt, id)`. The
 * agent passes back the prior response's `nextCursor` as `opts.cursor`
 * (decoded to `{ crackedAt, id }` at the route boundary); the filter
 * `(crackedAt > c.crackedAt) OR (crackedAt = c.crackedAt AND id > c.id)`
 * resumes strictly after that row, matching the `ORDER BY (crackedAt,
 * id)`. This walks every cracked row exactly once even when more than
 * `limit` rows share one `crackedAt` — the single-timestamp `since`
 * cursor could not (it skipped or replayed tied rows). `nextCursor` is
 * the encoded cursor of the last returned row when more remain, or
 * `null` at exhaustion. Mirrors the keyset pattern in
 * `services/results/export.ts` / `routes/dashboard/results.ts`, inverted
 * to ASC (`gt`, not `lt`).
 */
export type GetZapsForTaskResult = { zaps: string[]; nextCursor: string | null } | { error: string }

export async function getZapsForTask(
  taskId: number,
  agentId: number,
  projectId: number,
  opts: { cursor?: ZapCursor | undefined; limit?: number | undefined } = {}
): Promise<GetZapsForTaskResult> {
  // Clamp caller-supplied limit so an agent can't force an unbounded
  // in-memory read (the route is on a hot polling path; an agent
  // requesting `limit=10_000_000` would pull millions of rows + map
  // them, blocking the event loop). The default is also the ceiling.
  const requestedLimit = opts.limit ?? MAX_ZAPS_LIMIT
  const fetchLimit = Math.min(Math.max(requestedLimit, 1), MAX_ZAPS_LIMIT)

  // Single JOIN: tasks -> campaigns to get hashListId + verify ownership + project scope
  const [taskRow] = await db
    .select({
      taskId: tasks.id,
      hashListId: campaigns.hashListId,
    })
    .from(tasks)
    .innerJoin(campaigns, eq(tasks.campaignId, campaigns.id))
    .where(
      and(eq(tasks.id, taskId), eq(tasks.agentId, agentId), eq(campaigns.projectId, projectId))
    )
    .limit(1)

  if (!taskRow) {
    return { error: 'Task not found or not assigned to this agent' }
  }

  if (!taskRow.hashListId) {
    return { zaps: [], nextCursor: null }
  }

  // A leaf hashListId resolves to `[hashListId]` (identical to the
  // pre-SU4 single-id filter); a split parent resolves to `[hashListId,
  // ...childIds]` since its own hash_items were moved to its sub-lists
  // (#202 SU4). In the current split design a task's campaign always
  // points at a resolved (leaf) sub-list, never the parent, so this is a
  // no-op in practice — routed through the helper anyway for defense in
  // depth against a future campaign type that does target a parent
  // directly. Not deduped on hashValue: a duplicate zap costs the agent
  // one redundant skip check, not a correctness bug.
  const scopeIds = await resolveHashListScope(taskRow.hashListId, projectId)

  // Build conditions for cracked hash items. Typed to allow the
  // `or(...)` (which is `SQL | undefined`) without a non-null assertion —
  // `and(...conditions)` filters undefined itself, matching the pattern
  // in `services/results/export.ts`.
  const conditions: Array<SQL | undefined> = [
    inArray(hashItems.hashListId, scopeIds),
    isNotNull(hashItems.crackedAt),
  ]

  // Composite-cursor resume predicate. Drizzle's operator set is
  // single-column, so the row-value comparison
  // `(crackedAt, id) > (cursor.crackedAt, cursor.id)` is written as the
  // boolean expansion. NOTE: ASC ordering here means `gt`, not the `lt`
  // the DESC export paths use — mirroring them without flipping the
  // comparator is the classic bug this endpoint's tied-timestamp DB test
  // guards against.
  //
  // The leading `gte(crackedAt, cursor.crackedAt)` is LOGICALLY REDUNDANT
  // with the OR below (every row the OR admits also satisfies the `gte`),
  // but it is load-bearing for performance on this hot polling path: the
  // OR alone is not pushed into the index and forces a row-by-row Filter
  // that rescans the whole cracked-row range each page, so per-page cost
  // grows as the agent walks deeper. The `gte` restores the index range
  // bound (`Index Cond`) on `hash_items_hash_list_cracked_idx`, leaving
  // the OR as a cheap tie-break Filter. Same result set, seek instead of
  // scan.
  //
  // DO NOT REMOVE the `gte` as "redundant" — it is a query-plan optimization
  // (verified with EXPLAIN), not dead code. Deleting it silently degrades
  // this hot path to a full-range rescan; every correctness test stays green.
  if (opts.cursor) {
    conditions.push(
      gte(hashItems.crackedAt, opts.cursor.crackedAt),
      or(
        gt(hashItems.crackedAt, opts.cursor.crackedAt),
        and(eq(hashItems.crackedAt, opts.cursor.crackedAt), gt(hashItems.id, opts.cursor.id))
      )
    )
  }

  // Fetch limit+1 to detect whether more rows remain. Ordering uses
  // `(crackedAt, id)` so rows that share a `crackedAt` timestamp resolve
  // to the same order across calls; the `id` tiebreaker is load-bearing
  // for the composite cursor above.
  const rows = await db
    .select({
      hashValue: hashItems.hashValue,
      id: hashItems.id,
      crackedAt: hashItems.crackedAt,
    })
    .from(hashItems)
    .where(and(...conditions))
    .orderBy(hashItems.crackedAt, hashItems.id)
    .limit(fetchLimit + 1)

  const hasMore = rows.length > fetchLimit
  const page = hasMore ? rows.slice(0, fetchLimit) : rows
  const zaps = page.map((r) => r.hashValue)

  // Mint the continuation token from the last returned row when more remain.
  // `fetchLimit >= 1` (clamped above), so `hasMore` implies a non-empty page;
  // if that invariant is ever broken, throw LOUD rather than silently
  // returning `nextCursor: null` — a false "exhausted" signal would make the
  // agent stop polling and skip cracked hashes with no error to trace. The
  // throw routes through the route's catch to a logged 500 + TASK_ZAP_ERROR.
  let nextCursor: string | null = null
  if (hasMore) {
    const lastRow = page.at(-1)
    if (!lastRow) {
      throw new Error('zap pagination invariant violated: hasMore=true with an empty page')
    }
    // `crackedAt` is non-null on every row (the `isNotNull` filter above
    // guarantees it), so the assertion mirrors `results/export.ts`.
    nextCursor = encodeZapCursor({ crackedAt: lastRow.crackedAt!, id: lastRow.id })
  }

  return { zaps, nextCursor }
}
