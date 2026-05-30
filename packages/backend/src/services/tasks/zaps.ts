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
import { and, eq, gt, isNotNull } from 'drizzle-orm'

import { db } from '../../db/index.js'

/**
 * Hard ceiling on the number of zap rows returned per request.
 * Caller-supplied limits above this are clamped down; below 1 are
 * clamped up. This is the *only* bound between an agent's polling
 * query and the SQL planner, so a malformed or hostile agent can't
 * force a large in-memory read.
 */
const MAX_ZAPS_LIMIT = 10_000

/**
 * Returns "zaps" — hashes already cracked by any campaign sharing this
 * task's hash list — so the calling agent can skip them. Project-scoped
 * via the campaigns join so a leaked task id from another project
 * resolves to "task not found", not a cross-project read.
 */
export async function getZapsForTask(
  taskId: number,
  agentId: number,
  projectId: number,
  opts: { since?: Date | undefined; limit?: number | undefined } = {}
): Promise<{ zaps: string[]; hasMore: boolean } | { error: string }> {
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
    return { zaps: [], hasMore: false }
  }

  // Build conditions for cracked hash items
  const conditions = [eq(hashItems.hashListId, taskRow.hashListId), isNotNull(hashItems.crackedAt)]

  if (opts.since) {
    conditions.push(gt(hashItems.crackedAt, opts.since))
  }

  // Fetch limit+1 to detect hasMore. Ordering uses `(crackedAt, id)`
  // so rows that share a `crackedAt` timestamp resolve to the same
  // order across calls; without the `id` tiebreaker the planner picks
  // physical-storage order, which is non-deterministic. Resilient
  // pagination across tied timestamps still needs a composite cursor
  // on the wire (`since` is a single Date today) -- tracked in #182,
  // which has to ship with a coordinated agent-client + OpenAPI update.
  const rows = await db
    .select({ hashValue: hashItems.hashValue })
    .from(hashItems)
    .where(and(...conditions))
    .orderBy(hashItems.crackedAt, hashItems.id)
    .limit(fetchLimit + 1)

  const hasMore = rows.length > fetchLimit
  const zaps = (hasMore ? rows.slice(0, fetchLimit) : rows).map((r) => r.hashValue)

  return { zaps, hasMore }
}
