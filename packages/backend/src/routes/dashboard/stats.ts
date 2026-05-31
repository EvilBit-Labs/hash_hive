import {
  agents,
  campaigns,
  type DashboardStats,
  hashItems,
  hashLists,
  TASK_DB_TO_BUCKET,
  type TaskBucket,
  type TaskDbStatus,
  tasks,
} from '@hashhive/shared'
import { OpenAPIHono } from '@hono/zod-openapi'
import { and, eq, isNotNull, sql } from 'drizzle-orm'

import type { AppEnv } from '../../types.js'

import { db } from '../../db/index.js'
import { requireSession } from '../../middleware/auth.js'
import { requireProjectAccess } from '../../middleware/rbac.js'

const statsRoutes = new OpenAPIHono<AppEnv>()

statsRoutes.use('*', requireSession)

/**
 * Read a status-keyed count from a Drizzle group-by result, defaulting
 * to `0` when the literal is absent. The literal-keyed lookup replaces
 * the previous `Record<string, number>` mapping, which silently dropped
 * any status value not enumerated in the response shape (notably `busy`
 * and `benchmarked` agents). See `dashboardStatsSchema` for the canonical
 * field set and the read-endpoint contract at
 * `docs/solutions/conventions/dashboard-read-endpoint-contract.md` for
 * the compile-time-vs-runtime enforcement boundary.
 */
function countFor(rows: ReadonlyArray<{ status: string; count: number }>, literal: string): number {
  for (const row of rows) {
    if (row.status === literal) return Number(row.count)
  }
  return 0
}

function sumRows(rows: ReadonlyArray<{ count: number }>): number {
  let total = 0
  for (const row of rows) total += Number(row.count)
  return total
}

// GET /stats — project-scoped dashboard statistics
statsRoutes.get('/', requireProjectAccess(), async (c) => {
  // requireProjectAccess sets scopedUser; non-null assertion encodes
  // the middleware contract (CQ-H3).
  const { projectId } = c.get('scopedUser')!

  const [agentStats, campaignStats, taskStats, crackedStats] = await Promise.all([
    // Agent counts by status
    db
      .select({
        status: agents.status,
        count: sql<number>`count(*)`,
      })
      .from(agents)
      .where(eq(agents.projectId, projectId))
      .groupBy(agents.status),

    // Campaign counts by status
    db
      .select({
        status: campaigns.status,
        count: sql<number>`count(*)`,
      })
      .from(campaigns)
      .where(eq(campaigns.projectId, projectId))
      .groupBy(campaigns.status),

    // Task counts by status (join through campaigns for project scoping)
    db
      .select({
        status: tasks.status,
        count: sql<number>`count(*)`,
      })
      .from(tasks)
      .innerJoin(campaigns, eq(tasks.campaignId, campaigns.id))
      .where(eq(campaigns.projectId, projectId))
      .groupBy(tasks.status),

    // Total cracked hashes scoped by hash-list ownership, not by
    // campaign join. `hashItems.campaignId` is nullable (the FK uses
    // ON DELETE SET NULL — see `packages/shared/src/db/schema.ts`), so
    // joining through `campaigns` would silently drop cracked rows whose
    // campaign has been deleted. `hashItems.hashListId` is NOT NULL and
    // `hashLists.projectId` is NOT NULL, which is the contract intent
    // documented on `dashboardStatsSchema` ("count hash items with a
    // non-null `crackedAt` across the project's hash lists"). The
    // `hash_items_hash_list_cracked_idx` composite index on
    // `(hashListId, crackedAt)` is purpose-built for this access path.
    db
      .select({
        count: sql<number>`count(*)`,
      })
      .from(hashItems)
      .innerJoin(hashLists, eq(hashItems.hashListId, hashLists.id))
      .where(and(eq(hashLists.projectId, projectId), isNotNull(hashItems.crackedAt))),
  ])

  // Bucket task DB statuses into the operator-facing buckets defined by
  // `TASK_DB_TO_BUCKET` in `@hashhive/shared`. Same mapping
  // `getCampaignTaskStats` in `services/campaign-dashboard.ts` consumes —
  // centralizing here means a future DB-status rename touches the shared
  // constant once instead of every consumer.
  const taskBuckets: Record<TaskBucket, number> = {
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
  }
  for (const row of taskStats) {
    const bucket = TASK_DB_TO_BUCKET[row.status as TaskDbStatus]
    if (bucket !== undefined) {
      taskBuckets[bucket] += Number(row.count)
    }
    // Unknown DB statuses still contribute to `total` via `sumRows` below.
  }

  // Build the response from the shared schema's known literals; the
  // `DashboardStats` annotation makes a missing field a compile error.
  // Unknown DB literals not covered by the schema contribute to `total`
  // only — the contract test parses the response through
  // `dashboardStatsSchema` and would surface drift at CI time.
  const body: DashboardStats = {
    agents: {
      total: sumRows(agentStats),
      online: countFor(agentStats, 'online'),
      offline: countFor(agentStats, 'offline'),
      busy: countFor(agentStats, 'busy'),
      error: countFor(agentStats, 'error'),
      benchmarked: countFor(agentStats, 'benchmarked'),
    },
    campaigns: {
      total: sumRows(campaignStats),
      draft: countFor(campaignStats, 'draft'),
      running: countFor(campaignStats, 'running'),
      paused: countFor(campaignStats, 'paused'),
      completed: countFor(campaignStats, 'completed'),
      cancelled: countFor(campaignStats, 'cancelled'),
    },
    tasks: {
      total: sumRows(taskStats),
      pending: taskBuckets.pending,
      running: taskBuckets.running,
      completed: taskBuckets.completed,
      failed: taskBuckets.failed,
    },
    cracked: {
      total: Number(crackedStats[0]?.count ?? 0),
    },
  }

  return c.json(body)
})

export { statsRoutes }
