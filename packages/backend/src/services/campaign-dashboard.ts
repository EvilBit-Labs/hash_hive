/**
 * Campaign dashboard surface — service functions that back the
 * `/dashboard/campaigns` routes' enriched payloads and the draft-only
 * delete. Extracted from `services/campaigns.ts` to keep that file's
 * core CRUD + lifecycle layer under the project's 800-line guideline.
 *
 * Each function here is independently importable; callers should
 * import directly from this module rather than re-routing through
 * `services/campaigns.ts`.
 */
import {
  agents,
  attacks,
  type CampaignActiveAgent,
  type CampaignTaskStats,
  campaigns,
  TASK_DB_TO_BUCKET,
  type TaskBucket,
  type TaskDbStatus,
  tasks,
} from '@hashhive/shared'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'

import { logger } from '../config/logger.js'
import { db } from '../db/index.js'
import { emitCampaignStatus } from './events.js'

// ─── Task statistics ────────────────────────────────────────────────

/**
 * Aggregate task counts for a campaign, bucketed into the operator-facing
 * states defined by `TASK_DB_TO_BUCKET` in `@hashhive/shared`. The data
 * model carries more nuanced statuses (`assigned`, `exhausted`,
 * `cancelled`); the shared constant folds them into the four operator
 * buckets (`pending | running | completed | failed`). Unknown future
 * statuses count toward `total` only — extend `TASK_DB_TO_BUCKET` to add
 * one to a bucket.
 */
export async function getCampaignTaskStats(campaignId: number): Promise<CampaignTaskStats> {
  const rows = await db
    .select({
      status: tasks.status,
      n: sql<number>`count(*)::int`,
    })
    .from(tasks)
    .where(eq(tasks.campaignId, campaignId))
    .groupBy(tasks.status)

  const buckets: Record<TaskBucket, number> = {
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
  }
  let total = 0

  for (const row of rows) {
    const n = Number(row.n ?? 0)
    total += n
    const bucket = TASK_DB_TO_BUCKET[row.status as TaskDbStatus]
    if (bucket !== undefined) {
      buckets[bucket] += n
    }
    // Unknown statuses count only toward `total` (handled above).
  }

  return { total, ...buckets }
}

// ─── Active agents ──────────────────────────────────────────────────

const ACTIVE_AGENTS_LIMIT = 50

/**
 * Active agents working on a campaign right now. Joins tasks that are
 * pending, assigned, or running (the active-task set) and have a
 * non-null `agentId`. Speed is extracted from the task's progress
 * jsonb when available; falls back to null so callers can render a
 * placeholder. Capped at 50 rows with a stable order by `tasks.id`
 * so the visible subset is deterministic across refreshes.
 */
export async function listActiveAgentsByCampaign(
  campaignId: number
): Promise<CampaignActiveAgent[]> {
  const rows = await db
    .select({
      agentId: agents.id,
      agentName: agents.name,
      taskId: tasks.id,
      attackId: tasks.attackId,
      attackMode: attacks.mode,
      progress: tasks.progress,
    })
    .from(tasks)
    .innerJoin(agents, eq(tasks.agentId, agents.id))
    .innerJoin(attacks, eq(tasks.attackId, attacks.id))
    .where(
      and(
        eq(tasks.campaignId, campaignId),
        inArray(tasks.status, ['pending', 'assigned', 'running'])
      )
    )
    .orderBy(asc(tasks.id))
    .limit(ACTIVE_AGENTS_LIMIT)

  return rows.map((row) => {
    const progress = row.progress as Record<string, unknown> | null
    const rawSpeed = progress && typeof progress === 'object' ? progress['speedHs'] : null
    const speedHsValid = typeof rawSpeed === 'number' && Number.isFinite(rawSpeed)
    if (rawSpeed !== undefined && rawSpeed !== null && !speedHsValid) {
      // Surface protocol drift: agent reported a speed but it wasn't a
      // finite number. ETA computation treats it as null; the warn
      // lets us spot a misbehaving agent before its zero contribution
      // skews the dashboard.
      logger.warn(
        { agentId: row.agentId, taskId: row.taskId, rawSpeed },
        'listActiveAgentsByCampaign: dropping non-finite speedHs from active agent'
      )
    }
    return {
      agentId: row.agentId,
      agentName: row.agentName,
      taskId: row.taskId,
      attackId: row.attackId,
      attackMode: row.attackMode,
      progress: row.progress,
      speedHs: speedHsValid ? (rawSpeed as number) : null,
    }
  })
}

// ─── Draft-only delete ──────────────────────────────────────────────

export type DeleteCampaignResult =
  | { kind: 'deleted'; id: number; projectId: number }
  | { kind: 'not_found' }
  | { kind: 'not_draft'; status: string }

/**
 * Delete a campaign if and only if its status is `draft`. Attacks and
 * tasks are removed in the same transaction; FK constraints are not
 * CASCADE in the current schema, so child rows are deleted explicitly.
 *
 * Race safety: the parent DELETE folds the draft guard into its WHERE
 * clause so a concurrent `transitionCampaign` cannot flip the row out
 * of `draft` between a separate read-time check and the writes below.
 * Child-row deletes run first inside the same transaction; if the
 * parent DELETE returns zero rows we abort the transaction via a
 * thrown sentinel, leaving the child rows intact.
 */
export async function deleteCampaign(id: number): Promise<DeleteCampaignResult> {
  class StatusFlippedDuringDelete extends Error {
    constructor(public readonly observedStatus: string) {
      super('campaign status flipped before draft-only delete completed')
    }
  }

  try {
    const result = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ status: campaigns.status })
        .from(campaigns)
        .where(eq(campaigns.id, id))
        .limit(1)
      if (!existing) {
        return { kind: 'not_found' } as const
      }
      if (existing.status !== 'draft') {
        return { kind: 'not_draft', status: existing.status } as const
      }

      // Remove child rows (FKs are RESTRICT by default).
      await tx.delete(tasks).where(eq(tasks.campaignId, id))
      await tx.delete(attacks).where(eq(attacks.campaignId, id))

      // Atomic guard: only delete the campaign row if it is *still*
      // in draft. A concurrent transition that flipped the status
      // between the pre-check and this statement returns zero rows
      // and we abort the transaction so the child deletes also roll
      // back.
      const deleted = await tx
        .delete(campaigns)
        .where(and(eq(campaigns.id, id), eq(campaigns.status, 'draft')))
        .returning()
      const row = deleted[0]
      if (!row) {
        const [current] = await tx
          .select({ status: campaigns.status })
          .from(campaigns)
          .where(eq(campaigns.id, id))
          .limit(1)
        throw new StatusFlippedDuringDelete(current?.status ?? 'unknown')
      }
      return { kind: 'deleted', id: row.id, projectId: row.projectId } as const
    })

    // Emit a status event so other connected clients (and the
    // originating dashboard's stats card) drop the deleted campaign
    // without waiting for the next poll cycle.
    if (result.kind === 'deleted') {
      emitCampaignStatus(result.projectId, result.id, 'deleted')
    }
    return result
  } catch (err) {
    if (err instanceof StatusFlippedDuringDelete) {
      return { kind: 'not_draft', status: err.observedStatus }
    }
    throw err
  }
}
