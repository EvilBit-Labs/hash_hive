/**
 * Agent heartbeat processing (CQ-H4 / P-H1).
 *
 * Decomposed from a 228-line god-function in `services/agents.ts`. The
 * orchestrator (`processHeartbeat`) composes seven named helpers — each
 * representing one concern from the original inline comments — and is
 * now ~50 lines. The transaction span is preserved exactly as before:
 * the agent-row lock, task-ownership verify, optional error insert, and
 * status update all run inside the outer `db.transaction(...)` span;
 * the post-commit emits, fatal-task fan-out, and high-priority hint run
 * after the tx commits.
 *
 * Each helper is independently exported so unit tests can pin behavior
 * without standing up the full orchestrator. The orchestrator owns the
 * tx boundary and the dependency injection (the lazy-imported
 * `handleTaskFailure` and `buildCapabilityPredicate` from `./tasks.js`
 * stay here so the circular-import workaround lives next to the only
 * code path that needs it).
 */
import type { AgentHeartbeat } from '@hashhive/shared'

import { agents, campaigns, tasks } from '@hashhive/shared'
import { and, eq, sql } from 'drizzle-orm'

import { logger } from '../../config/logger.js'
import { db } from '../../db/index.js'
import {
  type DbClient,
  type HeartbeatTransition,
  type StatusTransitionReason,
  decideHeartbeatTransition,
  logAgentError,
  scrubAgentErrorContext,
} from '../agents.js'
import { emitAgentError, emitAgentStatus } from '../events.js'

// ─── Module-scoped state (warn throttle + lazy-import caches) ────────

/**
 * Once-per-agent guard for the "empty/malformed capabilities" warn. The
 * Set lives for the process lifetime so a noisy agent doesn't flood logs
 * each heartbeat. Operators see one warn per agent until the agent
 * announces real capabilities.
 */
const warnedEmptyCapsAgentIds = new Set<number>()

/**
 * Test-only reset for the warned-agent guard. Integration tests that
 * exercise the empty-capabilities path within a single process need to
 * reach the warn branch repeatedly with the same mock agent id; this
 * keeps the production guard intact while letting tests start each case
 * from a known empty state. Re-exported from `services/agents.ts` for
 * back-compat with the existing integration test import path.
 */
export function __resetWarnedEmptyCapsForTesting(): void {
  warnedEmptyCapsAgentIds.clear()
}

/**
 * Lazy reference to `handleTaskFailure` from `../tasks.js`. The static
 * import path is blocked by the circular dependency between
 * `services/agents.ts` and `services/tasks.ts` (tasks imports
 * `getAgentBenchmarkForMode` from agents). We resolve the module once
 * on first use and cache the function reference so every subsequent
 * fatal heartbeat skips the import-resolution roundtrip.
 *
 * Returns `null` (and logs) on import failure or unexpected export shape
 * so callers can degrade gracefully instead of bubbling a 500 to the
 * agent — the heartbeat must stay alive so the agent can keep checking
 * in even if a downstream module is misbehaving.
 */
let cachedHandleTaskFailure: typeof import('../tasks.js').handleTaskFailure | null = null

async function getHandleTaskFailure(): Promise<
  typeof import('../tasks.js').handleTaskFailure | null
> {
  if (cachedHandleTaskFailure != null) return cachedHandleTaskFailure
  try {
    const mod = await import('../tasks.js')
    if (typeof mod.handleTaskFailure !== 'function') {
      logger.error(
        { exportType: typeof mod.handleTaskFailure },
        'handleTaskFailure export is not a function — possible circular-import edge'
      )
      return null
    }
    cachedHandleTaskFailure = mod.handleTaskFailure
    return cachedHandleTaskFailure
  } catch (err) {
    logger.error({ err }, 'Failed to lazy-import handleTaskFailure from ../tasks.js')
    return null
  }
}

/**
 * Lazy reference to `buildCapabilityPredicate` from `../tasks.js`. Same
 * circular-import workaround as `getHandleTaskFailure` above — the
 * heartbeat high-priority check must filter against the agent's
 * capabilities so we never tell an agent to ask for work it cannot
 * actually claim. Returns `null` on import failure so the caller can
 * degrade by omitting the hint rather than 500-ing the heartbeat.
 */
let cachedBuildCapabilityPredicate: typeof import('../tasks.js').buildCapabilityPredicate | null =
  null

async function getBuildCapabilityPredicate(): Promise<
  typeof import('../tasks.js').buildCapabilityPredicate | null
> {
  if (cachedBuildCapabilityPredicate != null) return cachedBuildCapabilityPredicate
  try {
    const mod = await import('../tasks.js')
    if (typeof mod.buildCapabilityPredicate !== 'function') {
      logger.error(
        { exportType: typeof mod.buildCapabilityPredicate },
        'buildCapabilityPredicate export is not a function — possible circular-import edge'
      )
      return null
    }
    cachedBuildCapabilityPredicate = mod.buildCapabilityPredicate
    return cachedBuildCapabilityPredicate
  } catch (err) {
    logger.error({ err }, 'Failed to lazy-import buildCapabilityPredicate from ../tasks.js')
    return null
  }
}

function logStatusTransition(opts: {
  agentId: number
  projectId: number
  fromStatus: string
  toStatus: string
  reason: StatusTransitionReason
}): void {
  logger.info(
    {
      agentId: opts.agentId,
      projectId: opts.projectId,
      fromStatus: opts.fromStatus,
      toStatus: opts.toStatus,
      reason: opts.reason,
    },
    'Agent status transition'
  )
}

// ─── Helpers (concerns 1–7 from the original inline comments) ────────

/**
 * Concern 1: lock the agent row and capture its prior status + project.
 * The FOR UPDATE close the TOCTOU race where two concurrent heartbeats
 * would both observe the same prior status (per GOTCHAS.md "atomic
 * status guards").
 */
export async function lockAgentRow(
  tx: DbClient,
  agentId: number
): Promise<{
  priorRow: { status: string; projectId: number } | undefined
  priorStatus: string | null
}> {
  const [priorRow] = await tx
    .select({ status: agents.status, projectId: agents.projectId })
    .from(agents)
    .where(eq(agents.id, agentId))
    .for('update')
    .limit(1)
  return { priorRow, priorStatus: priorRow?.status ?? null }
}

/**
 * Concern 2: verify a heartbeat-supplied `currentTask.taskId` belongs
 * to the calling agent. Returns the taskId when ownership checks out,
 * `undefined` when it doesn't — `processHeartbeat` then persists the
 * error without the task linkage instead of attributing it to another
 * agent's task. Emits a `logger.warn` on mismatch so operators can
 * detect compromised tokens trying to corrupt audit trails.
 *
 * Runs inside the same tx as the agent_errors insert; the `for: 'update'`
 * lock on the task row closes the window where a concurrent
 * reassignment between verify and insert could let an error row
 * reference a task the agent no longer owns.
 */
export async function verifyTaskOwnership(
  tx: DbClient,
  agentId: number,
  taskId: number | undefined
): Promise<number | undefined> {
  if (taskId === undefined) return undefined
  const [row] = await tx
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.agentId, agentId)))
    .for('update')
    .limit(1)
  if (row) return row.id
  logger.warn(
    { agentId, taskId },
    'Heartbeat referenced currentTask.taskId not owned by this agent; dropping task linkage'
  )
  return undefined
}

/**
 * Concern 3: conditionally persist the heartbeat's error payload via
 * `logAgentError`, suppressing the SSE event so the post-commit phase
 * can emit it after the outer transaction commits.
 */
export async function persistHeartbeatError(
  tx: DbClient,
  args: {
    agentId: number
    error: NonNullable<AgentHeartbeat['error']>
    ownedTaskId: number | undefined
    projectId: number | undefined
  }
): Promise<void> {
  await logAgentError(
    {
      agentId: args.agentId,
      severity: args.error.severity,
      message: args.error.message,
      context: scrubAgentErrorContext(args.error.context) as Record<string, unknown> | undefined,
      taskId: args.ownedTaskId,
      projectId: args.projectId,
      suppressEvent: true,
    },
    tx
  )
}

/**
 * Concern 4: build the agent UPDATE set and apply it. Returns the
 * `returning()` row, which the post-commit phase needs for the SSE
 * project routing.
 */
export async function applyAgentUpdates(
  tx: DbClient,
  agentId: number,
  data: AgentHeartbeat,
  transition: HeartbeatTransition
): Promise<{ id: number; projectId: number; status: string; capabilities: unknown } | undefined> {
  const updates: Record<string, unknown> = {
    status: transition.effectiveStatus,
    lastSeenAt: new Date(),
    updatedAt: new Date(),
  }
  if (data.capabilities) updates['capabilities'] = data.capabilities
  if (data.deviceInfo) updates['hardwareProfile'] = data.deviceInfo

  const [updated] = await tx.update(agents).set(updates).where(eq(agents.id, agentId)).returning()
  return updated as
    | { id: number; projectId: number; status: string; capabilities: unknown }
    | undefined
}

/**
 * Concern 5: post-commit SSE emits + audit log. Runs after the outer
 * transaction commits so listeners never react to a status the DB
 * later rolls back. Block-level try/catch: if any single emit throws,
 * the remaining emits and the audit log are skipped. The next
 * heartbeat heals SSE state regardless.
 */
export function emitHeartbeatPostCommit(
  updated: { id: number; projectId: number },
  transition: HeartbeatTransition,
  error: AgentHeartbeat['error']
): void {
  try {
    if (error) {
      emitAgentError(updated.projectId, updated.id, error.severity)
    }
    emitAgentStatus(updated.projectId, updated.id, transition.effectiveStatus)

    if (transition.kind === 'transition') {
      logStatusTransition({
        agentId: updated.id,
        projectId: updated.projectId,
        fromStatus: transition.fromStatus,
        toStatus: transition.effectiveStatus,
        reason: transition.reason,
      })
    }
  } catch (postCommitErr: unknown) {
    logger.error(
      { err: postCommitErr, agentId: updated.id, projectId: updated.projectId },
      'Post-commit heartbeat emit/audit failed; agent state was already committed'
    )
  }
}

/**
 * Concern 6: fatal-task fan-out. On a fatal-error heartbeat, fail every
 * task the agent has assigned or running. Each task runs in its own
 * try/catch so a single failure does not strand sibling tasks; partial
 * failures are logged and surfaced in the return shape so callers /
 * monitoring can detect them. Runs AFTER the agent-row tx commits
 * because handleTaskFailure does its own DB work (including
 * transactional retries) and nesting drizzle transactions inside the
 * same connection produces savepoint churn we don't need here.
 *
 * Returns `undefined` for non-fatal heartbeats so the orchestrator can
 * conditionally include the summary in its return shape.
 */
export async function failActiveTasksOnFatal(
  agentId: number,
  transition: HeartbeatTransition,
  data: AgentHeartbeat
): Promise<{ attempted: number; failed: number } | undefined> {
  if (!transition.isFatalError) return undefined

  const activeTasks = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.agentId, agentId), sql`${tasks.status} IN ('assigned', 'running')`))

  const handleTaskFailure = await getHandleTaskFailure()
  let failed = 0
  if (handleTaskFailure === null) {
    failed = activeTasks.length
    logger.error(
      { agentId, attempted: activeTasks.length },
      'handleTaskFailure unavailable on fatal heartbeat; active tasks left in their current status until the sweep reaps them'
    )
  } else {
    for (const activeTask of activeTasks) {
      try {
        await handleTaskFailure(activeTask.id, agentId, data.error?.message ?? 'Agent fatal error')
      } catch (err) {
        failed += 1
        logger.error(
          { err, agentId, taskId: activeTask.id },
          'handleTaskFailure threw during fatal-heartbeat fan-out; sibling tasks continue'
        )
      }
    }
  }
  return { attempted: activeTasks.length, failed }
}

/**
 * Concern 7: high-priority pending-task hint. Tells the agent there's
 * priority-1 work waiting that matches its capabilities, so it can ask
 * for it on the next claim instead of waiting through the normal poll
 * interval. The filter mirrors `assignNextTask`'s SQL claim filter so a
 * "yes" answer here never lies. Skipped when the agent's status would
 * make assignNextTask refuse anyway (only `online` or `benchmarked` can
 * claim).
 *
 * Empty/malformed capabilities skip the lookup entirely — every task
 * carries a `hashcatMode` requirement, so a capability-less filter
 * zero-matches and we pay for the DB join for nothing. The
 * `warnedEmptyCapsAgentIds` set throttles the warn so operators see
 * one log line per agent until it announces real capabilities.
 */
export async function computeHighPriorityHint(
  updated: { id: number; projectId: number; status: string; capabilities: unknown } | undefined
): Promise<boolean> {
  if (!updated) return false
  const isClaimEligible = updated.status === 'online' || updated.status === 'benchmarked'
  if (!isClaimEligible) return false

  const rawCaps = updated.capabilities
  const capsIsObject = rawCaps !== null && typeof rawCaps === 'object' && !Array.isArray(rawCaps)
  const hasUsableHashModes =
    capsIsObject &&
    Array.isArray((rawCaps as Record<string, unknown>)['hashModes']) &&
    ((rawCaps as Record<string, unknown>)['hashModes'] as unknown[]).some((m) => {
      const n = Number(m)
      return Number.isFinite(n) && Number.isInteger(n)
    })

  if (!capsIsObject || !hasUsableHashModes) {
    if (!warnedEmptyCapsAgentIds.has(updated.id)) {
      warnedEmptyCapsAgentIds.add(updated.id)
      const capabilitiesType = !capsIsObject
        ? rawCaps === null
          ? 'null'
          : typeof rawCaps
        : 'object-without-usable-hashModes'
      logger.warn(
        { agentId: updated.id, capabilitiesType },
        'Agent has empty or non-object capabilities — high-priority hint disabled until announce'
      )
    }
    return false
  }

  const buildCapabilityPredicate = await getBuildCapabilityPredicate()
  if (buildCapabilityPredicate === null) return false

  const agentCaps = rawCaps as Record<string, unknown>
  const capabilityPredicate = buildCapabilityPredicate(agentCaps)
  const [highPriority] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .innerJoin(campaigns, eq(tasks.campaignId, campaigns.id))
    .where(
      and(
        eq(tasks.status, 'pending'),
        eq(campaigns.projectId, updated.projectId),
        sql`${campaigns.priority} <= 1`,
        capabilityPredicate
      )
    )
    .limit(1)
  return !!highPriority
}

// ─── Orchestrator ────────────────────────────────────────────────────

/**
 * Process an agent heartbeat: lock the agent row, verify any
 * referenced task ownership, persist a heartbeat-borne error (if
 * present), update the agent's status, then post-commit emit SSE,
 * fan out fatal-task failures, and compute the high-priority hint.
 *
 * Transaction span: concerns 1–4 (lock → verify → error insert →
 * status update) all run inside the outer `db.transaction(...)`. The
 * FOR UPDATE locks close the TOCTOU race where two concurrent
 * heartbeats would both observe the same prior status (per
 * GOTCHAS.md "atomic status guards"). Concerns 5–7 (emits, fatal
 * fan-out, high-priority hint) run AFTER the tx commits so SSE
 * clients never see a status that was rolled back, and so
 * `handleTaskFailure`'s own transactional retries don't nest
 * savepoints inside this connection.
 */
export async function processHeartbeat(agentId: number, data: AgentHeartbeat) {
  const txResult = await db.transaction(async (tx) => {
    const { priorRow, priorStatus } = await lockAgentRow(tx, agentId)
    const transition = decideHeartbeatTransition({
      payloadStatus: data.status,
      errorSeverity: data.error?.severity,
      priorStatus,
    })
    const ownedTaskId = await verifyTaskOwnership(tx, agentId, data.currentTask?.taskId)

    if (data.error) {
      await persistHeartbeatError(tx, {
        agentId,
        error: data.error,
        ownedTaskId,
        projectId: priorRow?.projectId,
      })
    }

    const updated = await applyAgentUpdates(tx, agentId, data, transition)
    return { updated, transition }
  })

  const { updated, transition } = txResult

  if (updated) {
    emitHeartbeatPostCommit(updated, transition, data.error)
  } else {
    // Auth middleware verified the agent's bearer token, so the row was
    // present a moment ago. A vanishing row mid-heartbeat means it was
    // deleted concurrently — surface it so an operator can correlate
    // bursts of "ghost heartbeat" warnings with cleanup actions.
    logger.warn(
      { agentId, status: transition.effectiveStatus },
      'Heartbeat for an agent row that no longer exists'
    )
  }

  const taskFailureSummary = await failActiveTasksOnFatal(agentId, transition, data)
  const hasHighPriorityTasks = await computeHighPriorityHint(updated)

  return {
    agent: updated ?? null,
    hasHighPriorityTasks,
    ...(taskFailureSummary ? { taskFailureSummary } : {}),
  }
}
