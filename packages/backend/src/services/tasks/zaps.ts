/**
 * Cracked-hash "zap" lookup for an agent's task (CQ-H1 split).
 *
 * Pulled from `services/tasks.ts` to bring the parent service under the
 * 800-line budget. Owns the single endpoint agents call to fetch hashes
 * that have already been cracked by any campaign sharing the same hash
 * list, so they can skip work they would otherwise duplicate.
 *
 * Re-exported from `services/tasks.ts` so the agent route
 * (`routes/agent/index.ts -> getZapsForTask`) sees no change in its
 * import path.
 */
import { campaigns, hashItems, tasks } from '@hashhive/shared'
import { and, eq, gt, isNotNull } from 'drizzle-orm'

import { db } from '../../db/index.js'

/**
 * Returns cracked hash values for a given task, scoped to the agent's project.
 * Used by agents to retrieve "zaps" — hashes cracked by any campaign sharing
 * the same hash list, so agents can skip already-cracked hashes.
 */
export async function getZapsForTask(
  taskId: number,
  agentId: number,
  projectId: number,
  opts: { since?: Date | undefined; limit?: number | undefined } = {}
): Promise<{ zaps: string[]; hasMore: boolean } | { error: string }> {
  const fetchLimit = opts.limit ?? 10_000

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

  // Fetch limit+1 to detect hasMore
  const rows = await db
    .select({ hashValue: hashItems.hashValue })
    .from(hashItems)
    .where(and(...conditions))
    .orderBy(hashItems.crackedAt)
    .limit(fetchLimit + 1)

  const hasMore = rows.length > fetchLimit
  const zaps = (hasMore ? rows.slice(0, fetchLimit) : rows).map((r) => r.hashValue)

  return { zaps, hasMore }
}
