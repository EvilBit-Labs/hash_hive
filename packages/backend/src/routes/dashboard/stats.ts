import { agents, campaigns, type DashboardStats, hashItems, tasks } from '@hashhive/shared'
import { and, eq, isNotNull, sql } from 'drizzle-orm'
import { Hono } from 'hono'

import type { AppEnv } from '../../types.js'

import { db } from '../../db/index.js'
import { requireSession } from '../../middleware/auth.js'
import { requireProjectAccess } from '../../middleware/rbac.js'

const statsRoutes = new Hono<AppEnv>()

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

    // Total cracked hashes (hash items with plaintext in this project's hash lists)
    db
      .select({
        count: sql<number>`count(*)`,
      })
      .from(hashItems)
      .innerJoin(
        campaigns,
        and(eq(hashItems.campaignId, campaigns.id), eq(campaigns.projectId, projectId))
      )
      .where(isNotNull(hashItems.crackedAt)),
  ])

  // Bucket task DB statuses into the operator-facing counts that
  // `campaignTaskStatsSchema` defines: `assigned` and `running` both count
  // as `running`; `exhausted` counts as `completed`. Unknown future
  // statuses count only toward `total`. Same mapping as
  // `getCampaignTaskStats` in `services/campaign-dashboard.ts`.
  const taskPending = countFor(taskStats, 'pending')
  const taskRunning = countFor(taskStats, 'running') + countFor(taskStats, 'assigned')
  const taskCompleted = countFor(taskStats, 'completed') + countFor(taskStats, 'exhausted')
  const taskFailed = countFor(taskStats, 'failed')

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
      pending: taskPending,
      running: taskRunning,
      completed: taskCompleted,
      failed: taskFailed,
    },
    cracked: {
      total: Number(crackedStats[0]?.count ?? 0),
    },
  }

  return c.json(body)
})

export { statsRoutes }
