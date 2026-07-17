/**
 * Control API stats endpoint. Mirrors the dashboard stats payload but
 * keys off the API-key-authenticated `currentUser` and returns RFC 9457
 * problems on failure paths. Wire shape and bucketing are identical to
 * `/api/v1/dashboard/stats`; both surfaces share `DashboardStats` from
 * `@hashhive/shared` per the dashboard read-endpoint contract.
 */

import {
  agents,
  campaigns,
  type DashboardStats,
  dashboardStatsSchema,
  hashItems,
  hashLists,
  TASK_DB_TO_BUCKET,
  type TaskBucket,
  type TaskDbStatus,
  tasks,
} from '@hashhive/shared'
import { createRoute, OpenAPIHono } from '@hono/zod-openapi'
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm'

import type { AppEnv } from '../../types.js'

import { db } from '../../db/index.js'
import {
  CONTROL_RESPONSE_REFS,
  controlOpenApiHonoOptions,
  sharedControlResponse,
} from '../../openapi/components.js'
import { controlErrorResponse, requireProjectMembership } from './helpers.js'

export const controlStatsRoutes = new OpenAPIHono<AppEnv>(controlOpenApiHonoOptions)

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

// Reuse the canonical `dashboardStatsSchema` from `@hashhive/shared`
// — the control and dashboard surfaces emit the same wire shape, and
// the local duplicate this file previously carried would drift the
// moment a field landed on one side. `.openapi('ControlStats')`
// registers the schema under a surface-specific component name so
// dashboard codegen still sees `DashboardStats` while control
// codegen sees `ControlStats`; the underlying shape is one source.
const controlStatsResponseSchema = dashboardStatsSchema.openapi('ControlStats')

const getStatsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Stats'],
  summary:
    'Aggregate counters for agents, campaigns, tasks, and cracked hashes in the active project',
  security: [{ ControlApiKey: [] }],
  responses: {
    200: {
      description: 'Aggregate stats.',
      content: { 'application/json': { schema: controlStatsResponseSchema } },
    },
    400: sharedControlResponse(CONTROL_RESPONSE_REFS.ValidationError),
    401: sharedControlResponse(CONTROL_RESPONSE_REFS.AuthError),
    403: sharedControlResponse(CONTROL_RESPONSE_REFS.Forbidden),
    500: sharedControlResponse(CONTROL_RESPONSE_REFS.InternalError),
  },
})

controlStatsRoutes.openapi(getStatsRoute, async (c) => {
  try {
    const { projectId } = await requireProjectMembership(c)

    const [agentStats, campaignStats, taskStats, crackedStats] = await Promise.all([
      db
        .select({ status: agents.status, count: sql<number>`count(*)` })
        .from(agents)
        .where(eq(agents.projectId, projectId))
        .groupBy(agents.status),
      db
        .select({ status: campaigns.status, count: sql<number>`count(*)` })
        .from(campaigns)
        // Split sub-campaigns (issue #202 second half) are children of a
        // parent campaign; without this filter a split campaign would count
        // as 1 parent + N sub-campaigns in the status breakdown instead of
        // once. Matches `listCampaigns`' flat-list exclusion in
        // `services/campaigns.ts` and the dashboard stats mirror.
        .where(and(eq(campaigns.projectId, projectId), isNull(campaigns.parentCampaignId)))
        .groupBy(campaigns.status),
      db
        .select({ status: tasks.status, count: sql<number>`count(*)` })
        .from(tasks)
        .innerJoin(campaigns, eq(tasks.campaignId, campaigns.id))
        .where(eq(campaigns.projectId, projectId))
        .groupBy(tasks.status),
      // Cracked-hash count scoped by hash-list ownership: see the
      // matching block in `routes/dashboard/stats.ts` for the
      // null-campaignId / contract-intent rationale. `count(distinct
      // hashValue)` (#202 SU4): see the matching comment in
      // `routes/dashboard/stats.ts` — dedupes a hashValue shared across
      // sibling split sub-lists (or any two lists) to ONE cracked target.
      db
        .select({ count: sql<number>`count(distinct ${hashItems.hashValue})` })
        .from(hashItems)
        .innerJoin(hashLists, eq(hashItems.hashListId, hashLists.id))
        .where(and(eq(hashLists.projectId, projectId), isNotNull(hashItems.crackedAt))),
    ])

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
    }

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

    return c.json(body, 200)
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})
