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
  hashItems,
  TASK_DB_TO_BUCKET,
  type TaskBucket,
  type TaskDbStatus,
  tasks,
} from '@hashhive/shared'
import { and, eq, isNotNull, sql } from 'drizzle-orm'
import { Hono } from 'hono'

import type { AppEnv } from '../../types.js'

import { db } from '../../db/index.js'
import { controlErrorResponse, requireProjectMembership } from './helpers.js'

export const controlStatsRoutes = new Hono<AppEnv>()

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

controlStatsRoutes.get('/', async (c) => {
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
        .where(eq(campaigns.projectId, projectId))
        .groupBy(campaigns.status),
      db
        .select({ status: tasks.status, count: sql<number>`count(*)` })
        .from(tasks)
        .innerJoin(campaigns, eq(tasks.campaignId, campaigns.id))
        .where(eq(campaigns.projectId, projectId))
        .groupBy(tasks.status),
      db
        .select({ count: sql<number>`count(*)` })
        .from(hashItems)
        .innerJoin(
          campaigns,
          and(eq(hashItems.campaignId, campaigns.id), eq(campaigns.projectId, projectId))
        )
        .where(isNotNull(hashItems.crackedAt)),
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

    return c.json(body)
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})
