/**
 * Control API stats endpoint. Mirrors the dashboard stats payload but
 * keys off the API-key-authenticated `currentUser` and returns RFC 9457
 * problems on failure paths.
 */

import { agents, campaigns, hashItems, tasks } from '@hashhive/shared';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { db } from '../../db/index.js';
import type { AppEnv } from '../../types.js';
import { controlErrorResponse, requireProjectId } from './_shared.js';

export const controlStatsRoutes = new Hono<AppEnv>();

controlStatsRoutes.get('/', async (c) => {
  try {
    const projectId = requireProjectId(c);

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
    ]);

    const agentCounts: Record<string, number> = {};
    let agentTotal = 0;
    for (const row of agentStats) {
      agentCounts[row.status] = Number(row.count);
      agentTotal += Number(row.count);
    }

    const campaignCounts: Record<string, number> = {};
    let campaignTotal = 0;
    for (const row of campaignStats) {
      campaignCounts[row.status] = Number(row.count);
      campaignTotal += Number(row.count);
    }

    const taskCounts: Record<string, number> = {};
    let taskTotal = 0;
    for (const row of taskStats) {
      taskCounts[row.status] = Number(row.count);
      taskTotal += Number(row.count);
    }

    return c.json({
      agents: {
        total: agentTotal,
        online: agentCounts['online'] ?? 0,
        offline: agentCounts['offline'] ?? 0,
        error: agentCounts['error'] ?? 0,
      },
      campaigns: {
        total: campaignTotal,
        draft: campaignCounts['draft'] ?? 0,
        running: campaignCounts['running'] ?? 0,
        paused: campaignCounts['paused'] ?? 0,
        completed: campaignCounts['completed'] ?? 0,
      },
      tasks: {
        total: taskTotal,
        pending: taskCounts['pending'] ?? 0,
        running: taskCounts['running'] ?? 0,
        completed: taskCounts['completed'] ?? 0,
        failed: taskCounts['failed'] ?? 0,
      },
      cracked: {
        total: Number(crackedStats[0]?.count ?? 0),
      },
    });
  } catch (err) {
    return controlErrorResponse(c, err);
  }
});
