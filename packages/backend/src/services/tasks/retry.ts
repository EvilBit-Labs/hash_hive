/**
 * Task retry & failure handling.
 *
 * Pulled from `services/tasks.ts` to bring the parent service under the
 * per-file size budget. The retry/failure concerns -- single-task
 * failure with retry budget, the stale-task sweep with its rebalance +
 * terminal-fail branches -- form a cohesive block; isolating them here
 * makes the retry policy navigable without scrolling past generation
 * and assignment logic.
 *
 * Re-exported from `services/tasks.ts` so callers (heartbeat lazy
 * import, agent route handlers, the heartbeat-monitor worker) see no
 * change in their import paths.
 */
import { agents, campaigns, tasks } from '@hashhive/shared'
import { and, eq, sql } from 'drizzle-orm'

import { logger } from '../../config/logger.js'
import { db } from '../../db/index.js'
import { enqueuePreemptionEvaluation, updateCampaignProgress } from '../campaigns.js'
import { emitTaskUpdate } from '../events.js'
import { jsonSafeBigint, readKeyspaceProgress, readWorkRangeField } from './_internals.js'

/**
 * Maximum reassignment count before a task is permanently failed. A task
 * with `retry_count >= MAX_RETRIES` reaching either failure path
 * (`handleTaskFailure` or the stale-task sweep) is marked terminal.
 * Exported so callers and tests can reason about the same bound.
 */
export const MAX_RETRIES = 3

export async function handleTaskFailure(taskId: number, agentId: number, reason: string) {
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.agentId, agentId)))
    .limit(1)
  if (!task) {
    return { error: 'Task not found or not assigned to this agent' }
  }

  // Preemption (#97 U6): a paused task still carries this agent_id. A
  // failure report must not un-pause it via the retry branch below — tell
  // the agent to stop instead (mirrors updateTaskProgress's paused guard).
  if (task.status === 'paused') {
    return { stopped: true as const }
  }

  const resultStats = (task.resultStats as Record<string, unknown>) ?? {}
  const { retryCount } = task

  // Derive projectId from the campaign for event emission
  const [campaign] = await db
    .select({ projectId: campaigns.projectId })
    .from(campaigns)
    .where(eq(campaigns.id, task.campaignId))
    .limit(1)

  if (retryCount < MAX_RETRIES) {
    // Retry: reset task to pending with incremented retry count
    const [updated] = await db
      .update(tasks)
      .set({
        status: 'pending',
        agentId: null,
        assignedAt: null,
        startedAt: null,
        failureReason: reason,
        retryCount: retryCount + 1,
        resultStats: { ...resultStats, lastFailure: reason },
        updatedAt: new Date(),
      })
      // Status guard (#97 U6) closes the TOCTOU window: a row paused between
      // the read above and this write is left untouched, not re-pended.
      .where(
        and(
          eq(tasks.id, taskId),
          eq(tasks.agentId, agentId),
          sql`${tasks.status} IN ('assigned', 'running')`
        )
      )
      .returning()

    if (!updated) {
      // Zero-row write: the task changed state between the read above and
      // this guarded write — paused by a concurrent preemption, or reassigned
      // by the stale sweep. Do NOT claim `retried: true` on a no-op write
      // (review #221: that silently told the agent its failure was retried).
      // Tell the agent to stop; it resyncs on its next poll / heartbeat.
      logger.warn(
        { taskId, agentId },
        'handleTaskFailure retry: task changed concurrently, no row updated — signalling stop'
      )
      return { stopped: true as const }
    }

    if (campaign) {
      // Surface the agent that was just freed so listeners can refresh that
      // agent's caches; the row itself no longer holds agentId after retry.
      emitTaskUpdate(campaign.projectId, taskId, 'pending', {
        agentId,
        campaignId: task.campaignId,
      })
    }

    return { task: updated, retried: true }
  }

  // Max retries exceeded — mark as failed permanently. Use the stable
  // terminal code `max_retries_exceeded` so this row is distinguishable
  // from a one-shot failure with the same underlying cause (the sweep's
  // terminal branches use the same code). The agent-reported reason that
  // tipped the task over the budget is preserved in resultStats.lastFailure
  // for debugging.
  //
  // Guard the UPDATE on agentId + status so a concurrent sweep that
  // already reassigned this row cannot cause us to mark a now-unowned
  // task as failed; only emit events when a row was actually updated.
  const [updated] = await db
    .update(tasks)
    .set({
      status: 'failed',
      failureReason: 'max_retries_exceeded',
      completedAt: new Date(),
      resultStats: { ...resultStats, lastFailure: reason },
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(tasks.id, taskId),
        eq(tasks.agentId, agentId),
        sql`${tasks.status} IN ('assigned', 'running')`
      )
    )
    .returning()

  if (!updated) {
    // Zero-row write (see the retry-branch note above): the row changed
    // concurrently. Signal stop rather than returning a silent
    // `retried: false` acknowledgement for a no-op write (review #221).
    logger.warn(
      { taskId, agentId },
      'handleTaskFailure terminal: task changed concurrently, no row updated — signalling stop'
    )
    return { stopped: true as const }
  }

  if (campaign) {
    emitTaskUpdate(campaign.projectId, taskId, 'failed', {
      agentId,
      campaignId: task.campaignId,
    })
    // Permanent fail changes the active-task count for the campaign; refresh
    // the aggregate so dashboards do not lag a sweep cycle. The sweep's
    // terminal-fail branches already do this — keep the two failure paths
    // symmetric so either subsystem keeps the aggregate honest.
    await updateCampaignProgress(task.campaignId)
    // A terminally-failed task frees its agent — re-evaluate preemption so
    // paused lower-priority victims can resume (#97 U6 completion trigger).
    await enqueuePreemptionEvaluation(campaign.projectId)
  }

  return { task: updated, retried: false }
}

/**
 * Stale-task descriptor carried through the sweep loop. Includes the
 * agent's current ownership so per-task UPDATEs can be guarded against a
 * concurrent sweep already reaping the same row.
 */
type StaleTaskRow = {
  taskId: number
  agentId: number | null
  campaignId: number
  workRange: unknown
  progress: unknown
  projectId: number
  retryCount: number
}

/**
 * Idempotency guard for per-task UPDATEs in the sweep. When the stale
 * row carries an agentId, require the row still belongs to that agent
 * (a concurrent sweep that already reassigned it makes our UPDATE a
 * no-op). When the row has no agentId (legacy migrated rows),
 * `sql\`TRUE\`` lets the status + id predicates carry the guard alone.
 */
function agentIdGuard(staleTask: StaleTaskRow) {
  return staleTask.agentId === null ? sql`TRUE` : eq(tasks.agentId, staleTask.agentId)
}

/**
 * Permanently fail a stale task and notify listeners. Three branches in
 * `reassignStaleTasks` reach a terminal state with the same row shape
 * (`failed` + reason + completedAt + updatedAt); centralising the body
 * keeps them from drifting.
 *
 * The UPDATE is guarded by `status IN ('assigned', 'running') AND
 * agent_id = staleTask.agentId` so a concurrent sweep (e.g. transient
 * overlap during a rolling deploy) cannot double-process the same row.
 * Returns `true` when the UPDATE actually changed a row; callers use
 * this to gate the event broadcast and aggregate refresh so a no-op
 * (row already swept by a peer) does not produce phantom transitions
 * or skew sweep metrics.
 */
async function terminalFailStaleTask(
  staleTask: StaleTaskRow,
  failureReason: 'keyspace_progress_overrun' | 'max_retries_exceeded'
): Promise<boolean> {
  const updated = await db
    .update(tasks)
    .set({
      status: 'failed',
      failureReason,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(tasks.id, staleTask.taskId),
        sql`${tasks.status} IN ('assigned', 'running')`,
        agentIdGuard(staleTask)
      )
    )
    .returning({ id: tasks.id })
  if (updated.length === 0) {
    return false
  }
  emitTaskUpdate(staleTask.projectId, staleTask.taskId, 'failed', {
    campaignId: staleTask.campaignId,
  })
  await updateCampaignProgress(staleTask.campaignId)
  // A terminally-failed task frees its agent — re-evaluate preemption so paused
  // lower-priority victims can resume. Mirrors handleTaskFailure's terminal
  // branch; without it, sweep/poison-failed tasks would orphan paused campaigns.
  await enqueuePreemptionEvaluation(staleTask.projectId)
  return true
}

/**
 * Backstop sweep for legacy pre-U10 tasks (lease_expires_at IS NULL).
 *
 * Since U11, expired-lease tasks (lease_expires_at < NOW()) are reclaimed
 * atomically by the claim CTE in assignNextTask — no sweep needed for them.
 * This function now targets only tasks that predate the lease column (NULL
 * lease_expires_at) and whose owning agent has gone offline.
 *
 * KNOWN GAP (resolved in U12): lease-bearing tasks reclaimed by the CTE no
 * longer pass through this function's retry-count increment / MAX_RETRIES
 * terminal-fail, so a poison task that no agent can progress would reclaim
 * forever. U12's committed_keyspace_offset supplies the missing signal — a
 * reclaim that did not advance the committed offset since claim is a retry
 * (count it; fail at MAX_RETRIES), versus a legitimate resume (do not penalize).
 *
 * Rebalance policy when a stale task carries non-zero
 * `progress.keyspaceProgress`:
 *
 *   - If progress exceeds the task's total keyspace, the agent reported a
 *     value the implementation cannot produce - mark the task `failed`
 *     immediately (data corruption, not a retryable agent failure).
 *   - Otherwise trim `workRange.start` forward by the reported progress so
 *     the next claimant doesn't re-execute the already-cracked range.
 *     `workRange.total` is recomputed from the new start/end.
 *
 * 0% progress falls through to the existing reset-to-pending behavior
 * unchanged.
 *
 * Per-task processing is wrapped in try/catch so a transient failure on
 * one stranded task (DB serialization, broadcast error, downstream throw)
 * does not strand the rest of the batch until the next sweep tick.
 */
export async function reassignStaleTasks(staleThresholdMs = 5 * 60 * 1000) {
  // ISO string, not a Date object: these comparisons are interpolated into raw
  // `sql` templates, and postgres.js binds a JS Date as a prepared-statement
  // parameter incorrectly (ERR_INVALID_ARG_TYPE). An ISO timestamp string binds
  // cleanly. Surfaced by the U12 real-DB lane (the mocked tests never ran it).
  const threshold = new Date(Date.now() - staleThresholdMs).toISOString()

  // Find tasks assigned to agents that haven't checked in. Carry workRange,
  // progress, projectId, campaignId, and retryCount so the rebalance branches
  // don't need extra queries to publish task_update events, update the
  // campaign progress aggregate, or gate on the retry budget.
  const staleTasks = await db
    .select({
      taskId: tasks.id,
      agentId: tasks.agentId,
      campaignId: tasks.campaignId,
      workRange: tasks.workRange,
      progress: tasks.progress,
      projectId: campaigns.projectId,
      retryCount: tasks.retryCount,
    })
    .from(tasks)
    .innerJoin(agents, eq(tasks.agentId, agents.id))
    .innerJoin(campaigns, eq(tasks.campaignId, campaigns.id))
    .where(
      and(
        // Include both 'assigned' (claimed but never reported) and 'running'
        // (claimed and reporting progress). The original 'assigned' filter
        // missed the only state that can carry meaningful keyspaceProgress
        // values from the agent API, leaving stranded in-progress work
        // un-rebalanced.
        sql`${tasks.status} IN ('assigned', 'running')`,
        sql`${agents.lastSeenAt} < ${threshold}`,
        // Guard against reaping a task the agent only just claimed after a
        // stale heartbeat — without this, a slow first-heartbeat after
        // assignment would race the sweep and yank the task back. The
        // IS NULL branch keeps legacy/migrated rows (status='assigned' with
        // no assigned_at) selectable instead of stranding them forever
        // (NULL < timestamp evaluates to NULL, which the filter rejects).
        sql`(${tasks.assignedAt} IS NULL OR ${tasks.assignedAt} < ${threshold})`,
        // U11 (KTD-5): expired-lease tasks are now reclaimed atomically by the
        // claim CTE in assignNextTask. This sweep only handles legacy pre-U10
        // rows that predate the lease column (lease_expires_at IS NULL).
        // NULL < NOW() evaluates to NULL (rejected by WHERE), so without this
        // predicate NULL-lease rows would correctly pass through — but being
        // explicit here documents the partition and prevents accidental
        // double-reclaim if the semantics of the CTE change in future units.
        sql`${tasks.leaseExpiresAt} IS NULL`
      )
    )

  let reassigned = 0
  let rebalanced = 0
  let failedOverrun = 0
  let failedMaxRetries = 0
  let errored = 0
  for (const staleTask of staleTasks) {
    try {
      const start = readWorkRangeField(staleTask.workRange, 'start')
      const end = readWorkRangeField(staleTask.workRange, 'end')
      const total = end > start ? end - start : 0n
      const keyspaceProgress = readKeyspaceProgress(staleTask.progress)
      const exceededRetries = staleTask.retryCount >= MAX_RETRIES

      if (keyspaceProgress >= total && total > 0n) {
        // Agent reported as-much-or-more work than the chunk contains. Either
        // the agent finished the entire range but died before sending the
        // completion message, or its report is malformed. Either way, the
        // chunk did not flow through the normal completion path - mark
        // failed so a fresh agent reruns the range rather than silently
        // trusting an un-acked completion. Only count the outcome when the
        // helper actually changed a row — a concurrent sweep that already
        // processed this task makes the UPDATE a no-op.
        if (await terminalFailStaleTask(staleTask, 'keyspace_progress_overrun')) {
          failedOverrun++
        }
        continue
      }

      if (keyspaceProgress > 0n && keyspaceProgress < total) {
        if (exceededRetries) {
          // Retry budget exhausted - permanent fail. Mirrors
          // handleTaskFailure's terminal branch; keep agentId so operators
          // can still see which agent dropped the task.
          if (await terminalFailStaleTask(staleTask, 'max_retries_exceeded')) {
            failedMaxRetries++
          }
          continue
        }

        // Partial progress - trim workRange.start forward and re-pend.
        const newStart = start + keyspaceProgress
        const newTotal = end - newStart
        // Reset reported keyspaceProgress so the next agent starts from 0
        // within the trimmed range, but preserve auxiliary samples (speed,
        // temperature) so the dashboard's per-task telemetry doesn't
        // momentarily blank out across a rebalance.
        const priorProgress =
          staleTask.progress && typeof staleTask.progress === 'object'
            ? (staleTask.progress as Record<string, unknown>)
            : {}
        const carriedProgress: Record<string, unknown> = { ...priorProgress }
        delete carriedProgress['keyspaceProgress']
        const rebalanceUpdated = await db
          .update(tasks)
          .set({
            status: 'pending',
            agentId: null,
            assignedAt: null,
            startedAt: null,
            workRange: {
              start: jsonSafeBigint(newStart),
              end: jsonSafeBigint(end),
              total: jsonSafeBigint(newTotal),
            },
            progress: carriedProgress,
            retryCount: sql`${tasks.retryCount} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(tasks.id, staleTask.taskId),
              sql`${tasks.status} IN ('assigned', 'running')`,
              agentIdGuard(staleTask)
            )
          )
          .returning({ id: tasks.id })
        if (rebalanceUpdated.length === 0) {
          continue
        }
        emitTaskUpdate(staleTask.projectId, staleTask.taskId, 'pending', {
          campaignId: staleTask.campaignId,
        })
        await updateCampaignProgress(staleTask.campaignId)
        rebalanced++
        continue
      }

      if (exceededRetries) {
        // 0% / unreadable progress but retry budget exhausted - permanent fail.
        if (await terminalFailStaleTask(staleTask, 'max_retries_exceeded')) {
          failedMaxRetries++
        }
        continue
      }

      // 0% progress or unreadable range - reset to pending unchanged.
      const resetUpdated = await db
        .update(tasks)
        .set({
          status: 'pending',
          agentId: null,
          assignedAt: null,
          startedAt: null,
          retryCount: sql`${tasks.retryCount} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(tasks.id, staleTask.taskId),
            sql`${tasks.status} IN ('assigned', 'running')`,
            agentIdGuard(staleTask)
          )
        )
        .returning({ id: tasks.id })
      if (resetUpdated.length === 0) {
        continue
      }
      emitTaskUpdate(staleTask.projectId, staleTask.taskId, 'pending', {
        campaignId: staleTask.campaignId,
      })
      await updateCampaignProgress(staleTask.campaignId)
      reassigned++
    } catch (err) {
      errored += 1
      logger.error(
        {
          err,
          taskId: staleTask.taskId,
          agentId: staleTask.agentId,
          campaignId: staleTask.campaignId,
          projectId: staleTask.projectId,
        },
        'reassignStaleTasks: per-task processing threw — sibling stale tasks continue'
      )
    }
  }

  // U12 poison-task fail: terminally fail tasks the claim CTE now refuses to
  // reclaim (lease expired AND retry_count >= MAX_RETRIES). These carry a
  // non-NULL (expired) lease, so the legacy NULL-lease sweep above skips them;
  // without this they would sit orphaned and the campaign could never complete.
  // A task that ever resumes resets retry_count to 0 (updateTaskProgress on
  // watermark advance), so only tasks no agent can progress reach MAX_RETRIES.
  const poisonTasks = await db
    .select({
      taskId: tasks.id,
      agentId: tasks.agentId,
      campaignId: tasks.campaignId,
      workRange: tasks.workRange,
      progress: tasks.progress,
      projectId: campaigns.projectId,
      retryCount: tasks.retryCount,
    })
    .from(tasks)
    .innerJoin(campaigns, eq(tasks.campaignId, campaigns.id))
    .where(
      and(
        sql`${tasks.status} IN ('assigned', 'running')`,
        sql`${tasks.leaseExpiresAt} < NOW()`,
        sql`${tasks.retryCount} >= ${MAX_RETRIES}`
      )
    )
  for (const poison of poisonTasks) {
    try {
      if (await terminalFailStaleTask(poison, 'max_retries_exceeded')) {
        // terminalFailStaleTask already emits the failed event, recomputes the
        // campaign aggregate, and enqueues preemption re-evaluation — do not
        // duplicate them here (matches the main-sweep call sites above).
        failedMaxRetries++
      }
    } catch (err) {
      errored += 1
      logger.error(
        { err, taskId: poison.taskId, campaignId: poison.campaignId },
        'reassignStaleTasks: poison-task terminal-fail threw'
      )
    }
  }

  return { reassigned, rebalanced, failedOverrun, failedMaxRetries, errored }
}
