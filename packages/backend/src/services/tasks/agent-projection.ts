/**
 * Per-agent task listing + projection.
 *
 * Pulled from `services/tasks.ts` to bring the parent service under the
 * per-file size budget. Owns the SQL join that fetches an agent's
 * active tasks for the dashboard detail view and the pure
 * row-to-wire-shape projection that's reused by tests.
 *
 * Re-exported from `services/tasks.ts` so the dashboard agent route
 * (`routes/dashboard/agents.ts -> listTasksByAgent`) and the projection
 * test (`tests/unit/agents-service.test.ts`) see no change in their
 * import paths.
 */
import type { AgentTaskSummary } from '@hashhive/shared'

import { attacks, campaigns, tasks } from '@hashhive/shared'
import { and, desc, eq, inArray } from 'drizzle-orm'

import { db } from '../../db/index.js'

export const AGENT_TASK_ACTIVE_STATUSES = ['pending', 'assigned', 'running'] as const
export type AgentTaskActiveStatus = (typeof AGENT_TASK_ACTIVE_STATUSES)[number]

/**
 * Test-only: convert a raw join-row shape (same fields the SQL selects)
 * into the wire-shape AgentTaskSummary[]. Exported so the projection
 * logic — Date→ISO conversion, progress fallback, status preservation —
 * can be unit-tested without a database.
 */
export function projectAgentTaskRows(
  rows: ReadonlyArray<{
    id: number
    campaignId: number
    campaignName: string
    attackId: number
    attackMode: number
    status: string
    progress: unknown
    startedAt: Date | string | null
    assignedAt: Date | string | null
  }>
): AgentTaskSummary[] {
  const iso = (v: Date | string | null): string | null => {
    if (v === null) return null
    if (v instanceof Date) return v.toISOString()
    return v
  }
  // Defend the AgentTaskSummary contract -- `progress` is a `z.record(...)`
  // in @hashhive/shared, so anything that's not a plain object (legacy
  // rows, numeric/string sentinels from an older agent, accidental
  // arrays from a future schema regression) must collapse to `{}`
  // rather than ride a bare cast through to consumers. The previous
  // `(row.progress as ...) ?? {}` only filtered `null`/`undefined`.
  const narrowProgress = (raw: unknown): Record<string, unknown> => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
    return raw as Record<string, unknown>
  }
  return rows.map((row) => ({
    id: row.id,
    campaignId: row.campaignId,
    campaignName: row.campaignName,
    attackId: row.attackId,
    attackMode: row.attackMode,
    status: row.status,
    progress: narrowProgress(row.progress),
    startedAt: iso(row.startedAt),
    assignedAt: iso(row.assignedAt),
  }))
}

/**
 * Returns active tasks assigned to an agent (pending, assigned, running),
 * joined with campaign and attack names for display in the agent detail UI.
 *
 * Project scope is enforced at the service boundary via the campaigns
 * INNER JOIN. The caller is still expected to verify the agent itself
 * belongs to the project (404 vs leaking "this agent exists elsewhere"),
 * but the projectId predicate here is defense-in-depth.
 */
export async function listTasksByAgent(
  agentId: number,
  projectId: number
): Promise<AgentTaskSummary[]> {
  const rows = await db
    .select({
      id: tasks.id,
      campaignId: campaigns.id,
      campaignName: campaigns.name,
      attackId: attacks.id,
      attackMode: attacks.mode,
      status: tasks.status,
      progress: tasks.progress,
      startedAt: tasks.startedAt,
      assignedAt: tasks.assignedAt,
    })
    .from(tasks)
    .innerJoin(campaigns, eq(tasks.campaignId, campaigns.id))
    .innerJoin(attacks, eq(tasks.attackId, attacks.id))
    .where(
      and(
        eq(tasks.agentId, agentId),
        eq(campaigns.projectId, projectId),
        inArray(tasks.status, [...AGENT_TASK_ACTIVE_STATUSES])
      )
    )
    .orderBy(desc(tasks.startedAt), desc(tasks.assignedAt))

  return projectAgentTaskRows(rows)
}
