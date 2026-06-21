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
  type CampaignArchiveResponse,
  type CampaignRestoreResponse,
  type CampaignTaskStats,
  campaigns,
  TASK_DB_TO_BUCKET,
  type TaskBucket,
  type TaskDbStatus,
  tasks,
} from '@hashhive/shared'
import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'

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
  // A campaign that has ever left draft is permanent (ADR-0019): it can be
  // archived but never hard-deleted, even after editing returns it to draft.
  | { kind: 'not_permanent' }

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
export async function deleteCampaign(id: number, projectId: number): Promise<DeleteCampaignResult> {
  class StatusFlippedDuringDelete extends Error {
    constructor(
      public readonly observedStatus: string,
      public readonly observedPermanent: boolean
    ) {
      super('campaign status flipped before draft-only delete completed')
    }
  }

  try {
    const result = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ status: campaigns.status, isPermanent: campaigns.isPermanent })
        .from(campaigns)
        .where(and(eq(campaigns.id, id), eq(campaigns.projectId, projectId)))
        .limit(1)
      if (!existing) {
        return { kind: 'not_found' } as const
      }
      if (existing.status !== 'draft') {
        return { kind: 'not_draft', status: existing.status } as const
      }
      // A started-then-edited campaign sits at status='draft' but is
      // permanent. Status alone would let it through — reject on the latch.
      if (existing.isPermanent) {
        return { kind: 'not_permanent' } as const
      }

      // Remove child rows (FKs are RESTRICT by default).
      await tx.delete(tasks).where(eq(tasks.campaignId, id))
      await tx.delete(attacks).where(eq(attacks.campaignId, id))

      // Atomic guard: only delete the campaign row if it is *still* a
      // pristine draft (draft AND not permanent). A concurrent transition
      // that flipped the status or latched permanence between the pre-check
      // and this statement returns zero rows and we abort the transaction
      // so the child deletes also roll back.
      const deleted = await tx
        .delete(campaigns)
        .where(
          and(
            eq(campaigns.id, id),
            eq(campaigns.projectId, projectId),
            eq(campaigns.status, 'draft'),
            eq(campaigns.isPermanent, false)
          )
        )
        .returning()
      const row = deleted[0]
      if (!row) {
        const [current] = await tx
          .select({ status: campaigns.status, isPermanent: campaigns.isPermanent })
          .from(campaigns)
          .where(eq(campaigns.id, id))
          .limit(1)
        // Throw (not return) so the child deletes above roll back. The catch
        // maps to not_permanent or not_draft based on what changed.
        throw new StatusFlippedDuringDelete(
          current?.status ?? 'unknown',
          current?.isPermanent ?? false
        )
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
      return err.observedPermanent
        ? { kind: 'not_permanent' }
        : { kind: 'not_draft', status: err.observedStatus }
    }
    throw err
  }
}

// ─── Archive / restore (ADR-0019) ───────────────────────────────────
//
// Archivable = the done states (`completed`, `cancelled`). Live campaigns
// (`running`/`paused`) and `draft` (pristine or reopened for editing) are not
// archivable. Project scope is folded into each guarded UPDATE so a
// cross-project id simply reports `not_found` rather than mutating another
// project's row. Bulk by design: a single archive/restore is `ids: [one]`.
const ARCHIVABLE_STATUSES = ['completed', 'cancelled'] as const

export async function archiveCampaigns(
  projectId: number,
  ids: number[]
): Promise<CampaignArchiveResponse['results']> {
  const results: CampaignArchiveResponse['results'] = []
  for (const id of ids) {
    const updated = await db
      .update(campaigns)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(campaigns.id, id),
          eq(campaigns.projectId, projectId),
          inArray(campaigns.status, [...ARCHIVABLE_STATUSES]),
          isNull(campaigns.archivedAt)
        )
      )
      .returning({ id: campaigns.id })
    if (updated[0]) {
      results.push({ id, outcome: 'archived' })
      continue
    }
    // Classify the miss against the project-scoped row.
    const [row] = await db
      .select({ status: campaigns.status, archivedAt: campaigns.archivedAt })
      .from(campaigns)
      .where(and(eq(campaigns.id, id), eq(campaigns.projectId, projectId)))
      .limit(1)
    if (!row) {
      results.push({ id, outcome: 'not_found' })
    } else if (row.archivedAt) {
      results.push({ id, outcome: 'already_archived' })
    } else {
      results.push({ id, outcome: 'not_archivable' })
    }
  }
  return results
}

export async function restoreCampaigns(
  projectId: number,
  ids: number[]
): Promise<CampaignRestoreResponse['results']> {
  const results: CampaignRestoreResponse['results'] = []
  for (const id of ids) {
    const updated = await db
      .update(campaigns)
      .set({ archivedAt: null, updatedAt: new Date() })
      .where(
        and(
          eq(campaigns.id, id),
          eq(campaigns.projectId, projectId),
          isNotNull(campaigns.archivedAt)
        )
      )
      .returning({ id: campaigns.id })
    if (updated[0]) {
      results.push({ id, outcome: 'restored' })
      continue
    }
    const [row] = await db
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(and(eq(campaigns.id, id), eq(campaigns.projectId, projectId)))
      .limit(1)
    results.push({ id, outcome: row ? 'not_archived' : 'not_found' })
  }
  return results
}
