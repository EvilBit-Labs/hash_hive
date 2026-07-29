/**
 * Cracked-hash "zap" lookup for an agent's task.
 *
 * Pulled from `services/tasks.ts` to bring the parent service under the
 * per-file size budget. Owns the single endpoint agents call to fetch
 * hashes that have already been cracked anywhere in the task's project at
 * the same hashcat mode, so they can skip work they would otherwise
 * duplicate. Resolution is against the maintained per-project cracked-set
 * (`project_cracked_hashes`, SuperHashlists Layer one) at project+mode
 * scope — NOT the task's single hash list — so a value cracked in ANY list
 * in the project (a sibling list, another campaign, a super member) zaps
 * every same-mode task in that project (KTD4 / R8 / R16).
 *
 * Re-exported from `services/tasks.ts` so the agent route
 * (`routes/agent/index.ts -> getZapsForTask`) sees no change in its
 * import path. The agent wire contract (`{ zaps, nextCursor }`) and the
 * exactly-once composite cursor are preserved by this widening.
 */
import { campaigns, projectCrackedHashes, tasks } from '@hashhive/shared'
import { and, eq, gt, gte, isNotNull, or, type SQL } from 'drizzle-orm'

import { db } from '../../db/index.js'
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
 * Returns "zaps" — hashes already cracked anywhere in this task's project
 * at the same hashcat mode — so the calling agent can skip them. Resolution
 * reads the maintained per-project cracked-set (`project_cracked_hashes`)
 * scoped by `projectId = ? AND hashcatMode = ?`, so a value first cracked in
 * one list zaps every same-mode task across the project's other lists (R8 /
 * R16 / AE2). Project scope is enforced by the `campaigns.projectId` join, so
 * a leaked task id from another project resolves to "task not found", not a
 * cross-project read.
 *
 * The task's hashcat mode is the campaign's latched `hashcatMode` (read via
 * the `tasks ⋈ campaigns` JOIN). A campaign with no attacks yet has a null
 * mode — nothing has entered the cracked-set for it, so there is nothing to
 * zap and the endpoint returns an empty page.
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

  // Single JOIN: tasks -> campaigns to get the campaign's latched hashcat
  // mode + verify ownership + project scope. The dedup key is (mode, value)
  // (KTD3), so the mode is what scopes the cracked-set scan below alongside
  // the `projectId` param.
  const [taskRow] = await db
    .select({
      taskId: tasks.id,
      hashcatMode: campaigns.hashcatMode,
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

  // A campaign with no attacks yet has a null latched mode. No mode means
  // nothing this campaign cracks could have entered the cracked-set (the
  // write path (U2) keys on the resolved mode, KTD3), so there is nothing to
  // zap — return an empty page rather than scanning every mode in the project.
  if (taskRow.hashcatMode === null) {
    return { zaps: [], nextCursor: null }
  }

  // Resolve zaps from the maintained per-project cracked-set at project+mode
  // scope (KTD4). This replaces the old single-`hashListId` `hash_items` scan:
  // a value cracked in ANY list in this project (sibling list, other campaign,
  // super member) is a project-wide zap for every same-mode task (R8 / R16 /
  // AE2). Ownership + project scope are already enforced by the
  // `campaigns.projectId` join above.
  //
  // Typed to allow the `or(...)` (which is `SQL | undefined`) without a
  // non-null assertion — `and(...conditions)` filters undefined itself,
  // matching the pattern in `services/results/export.ts`.
  //
  // `crackedAt` is NOT NULL on `project_cracked_hashes` (the keyset column),
  // so the `isNotNull` guard is belt-and-suspenders — kept to mirror the
  // filter shape the endpoint has always run.
  const conditions: Array<SQL | undefined> = [
    eq(projectCrackedHashes.projectId, projectId),
    eq(projectCrackedHashes.hashcatMode, taskRow.hashcatMode),
    isNotNull(projectCrackedHashes.crackedAt),
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
  // bound (`Index Cond`) on `project_cracked_hashes_keyset_idx` (the keyset
  // index `(projectId, hashcatMode, crackedAt, id)` created in U1), leaving
  // the OR as a cheap tie-break Filter. Same result set, seek instead of
  // scan.
  //
  // DO NOT REMOVE the `gte` as "redundant" — it is a query-plan optimization
  // (verified with EXPLAIN), not dead code. Deleting it silently degrades
  // this hot path to a full-range rescan; every correctness test stays green.
  if (opts.cursor) {
    conditions.push(
      gte(projectCrackedHashes.crackedAt, opts.cursor.crackedAt),
      or(
        gt(projectCrackedHashes.crackedAt, opts.cursor.crackedAt),
        and(
          eq(projectCrackedHashes.crackedAt, opts.cursor.crackedAt),
          gt(projectCrackedHashes.id, opts.cursor.id)
        )
      )
    )
  }

  // Fetch limit+1 to detect whether more rows remain. Ordering uses
  // `(crackedAt, id)` so rows that share a `crackedAt` timestamp resolve
  // to the same order across calls; the `id` tiebreaker is load-bearing
  // for the composite cursor above.
  const rows = await db
    .select({
      hashValue: projectCrackedHashes.hashValue,
      id: projectCrackedHashes.id,
      crackedAt: projectCrackedHashes.crackedAt,
    })
    .from(projectCrackedHashes)
    .where(and(...conditions))
    .orderBy(projectCrackedHashes.crackedAt, projectCrackedHashes.id)
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
    // `crackedAt` is non-null on every row (NOT NULL on the cracked-set table,
    // plus the `isNotNull` filter above), so the assertion mirrors
    // `results/export.ts`.
    nextCursor = encodeZapCursor({ crackedAt: lastRow.crackedAt!, id: lastRow.id })
  }

  return { zaps, nextCursor }
}
