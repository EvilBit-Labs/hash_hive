/**
 * Priority-based task preemption (issue #97 U3 + U6).
 *
 * `evaluatePreemption(projectId)` runs two passes inside a single
 * transaction guarded by a per-project Postgres advisory lock so the pause
 * pass and the resume pass for one project can never interleave with a
 * concurrent evaluation (triggers (a) priority change, (b) → running, and
 * (c) task/campaign terminal states can all enqueue near-simultaneously;
 * BullMQ workers default to parallel). The advisory lock is the
 * serialization defense; `FOR UPDATE SKIP LOCKED` / the status guard folded
 * into each write handles agent-driven status changes that do not take the
 * lock.
 *
 * Pause pass (U3): pause the lowest-priority capability-matching running or
 * assigned task to free an agent for higher-priority pending work.
 * Resume pass (U6): re-pend paused tasks whose resources are no longer
 * needed by higher-priority work.
 *
 * Lives under `services/tasks/` per the barrel-plus-subdir convention.
 */
import { agents, campaigns, tasks } from '@hashhive/shared'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'

import { logger } from '../../config/logger.js'
import { db } from '../../db/index.js'
import { emitTaskUpdate } from '../events.js'
import { recordTaskEvent } from './task-events.js'

/**
 * A resumed task is excluded from re-preemption for this window so a
 * resume → reclaim → re-preempt loop cannot form under sustained priority
 * churn. The pause-candidate query filters on it; harmless before U6
 * populates `resumed_at`.
 */
export const RESUME_STABILITY_FLOOR_MS = 30_000

/**
 * First key of the two-int `pg_advisory_xact_lock(key1, key2)` call. Pinned
 * to the issue number so preemption locks share a namespace distinct from
 * any other advisory-lock site; the second key is the project id.
 */
const PREEMPTION_LOCK_NAMESPACE = 97

/** Drizzle transaction handle inferred from `db.transaction`. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Ids of an agent's tasks that were preempted (paused with
 * `pausedReason='preempted'`). The heartbeat handler surfaces these as
 * `stopTaskIds` so the agent stops the abandoned work (#97 U4). A preempted
 * task deliberately retains its `agent_id` while paused, which is what makes
 * this lookup possible without a separate signal store.
 */
export async function getStopTaskIdsForAgent(agentId: number): Promise<number[]> {
  const rows = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.agentId, agentId),
        eq(tasks.status, 'paused'),
        eq(tasks.pausedReason, 'preempted')
      )
    )
  return rows.map((r) => r.id)
}

type Caps = Record<string, unknown> | null | undefined

export interface PreemptionResult {
  pausedTaskIds: number[]
  resumedTaskIds: number[]
}

/**
 * Whether an agent's capabilities satisfy a task's required_capabilities.
 * JS mirror of `buildCapabilityPredicate` in `services/tasks.ts` (GPU
 * requirement + hashcatMode membership) so the app-side preemption match
 * agrees with the SQL-side assignment match.
 */
export function agentCanRunTask(agentCaps: Caps, requiredCaps: Caps): boolean {
  const caps: Record<string, unknown> = agentCaps ?? {}
  const req: Record<string, unknown> = requiredCaps ?? {}

  // GPU: if the task needs a GPU, the agent must advertise one.
  if (req['gpu'] === true && caps['gpu'] !== true) return false

  // Hash mode: no requirement → always satisfied. With a requirement, the
  // agent must advertise the mode (an agent with no modes fails, matching
  // the SQL predicate's `hashcatMode IS NULL` fallback).
  const reqMode = req['hashcatMode']
  if (reqMode === undefined || reqMode === null) return true
  const reqModeNum = Number(reqMode)
  if (!Number.isFinite(reqModeNum) || !Number.isInteger(reqModeNum)) return true
  const rawModes = Array.isArray(caps['hashModes']) ? caps['hashModes'] : []
  const modes = rawModes
    .map((m: unknown) => Number(m))
    .filter((n): n is number => Number.isFinite(n) && Number.isInteger(n))
  return modes.includes(reqModeNum)
}

interface PendingRow {
  id: number
  campaignId: number
  priority: number
  requiredCapabilities: Caps
}

interface VictimRow {
  id: number
  agentId: number | null
  campaignId: number
  priority: number
  status: string
  agentCaps: Caps
}

/**
 * Atomically pause a victim task. The status guard + project scope are
 * folded into the UPDATE WHERE so a task that changed state since it was
 * loaded (e.g. an agent completed it) is left untouched. `agent_id` is
 * deliberately retained so the heartbeat stop-signal stays derivable;
 * resume clears it. Returns the freed agent id, or null if no row matched.
 */
async function pauseVictim(
  tx: Tx,
  victimId: number,
  projectId: number,
  byCampaignId: number
): Promise<{ agentId: number | null } | null> {
  const res = await tx.execute(sql`
    UPDATE ${tasks}
    SET status = 'paused',
        paused_reason = 'preempted',
        preempted_by_campaign_id = ${byCampaignId},
        paused_at = NOW(),
        updated_at = NOW()
    FROM ${campaigns}
    WHERE ${tasks.id} = ${victimId}
      AND ${tasks.campaignId} = ${campaigns.id}
      AND ${campaigns.projectId} = ${projectId}
      AND ${tasks.status} IN ('running', 'assigned')
    RETURNING ${tasks.id}, ${tasks.agentId}
  `)
  const row = res[0] as { id: number; agent_id: number | null } | undefined
  return row ? { agentId: row.agent_id } : null
}

/**
 * Pause pass: greedily free agents for higher-priority pending work by
 * pausing the lowest-priority capability-matching running/assigned task.
 * Returns the ids of tasks paused this pass.
 */
async function runPausePass(tx: Tx, projectId: number): Promise<number[]> {
  // Higher-priority pending work, highest priority (lowest number) first.
  const pending = (await tx
    .select({
      id: tasks.id,
      campaignId: tasks.campaignId,
      priority: campaigns.priority,
      requiredCapabilities: tasks.requiredCapabilities,
    })
    .from(tasks)
    .innerJoin(campaigns, eq(tasks.campaignId, campaigns.id))
    .where(
      and(
        eq(tasks.status, 'pending'),
        sql`${tasks.agentId} IS NULL`,
        eq(campaigns.projectId, projectId)
      )
    )
    .orderBy(campaigns.priority, tasks.id)) as PendingRow[]

  if (pending.length === 0) return []

  // Preemptable running/assigned tasks with their agent's caps, lowest
  // priority (highest number) first so the best victim is found first.
  // Recently-resumed tasks are excluded (anti-thrash stability floor).
  const running = (await tx
    .select({
      id: tasks.id,
      agentId: tasks.agentId,
      campaignId: tasks.campaignId,
      priority: campaigns.priority,
      status: tasks.status,
      agentCaps: agents.capabilities,
    })
    .from(tasks)
    .innerJoin(campaigns, eq(tasks.campaignId, campaigns.id))
    .innerJoin(agents, eq(tasks.agentId, agents.id))
    .where(
      and(
        inArray(tasks.status, ['running', 'assigned']),
        eq(campaigns.projectId, projectId),
        sql`(${tasks.resumedAt} IS NULL OR ${tasks.resumedAt} < NOW() - ${RESUME_STABILITY_FLOOR_MS} * INTERVAL '1 millisecond')`
      )
    )
    .orderBy(desc(campaigns.priority), tasks.id)) as VictimRow[]

  if (running.length === 0) return []

  // Idle capability-matching agents already cover some pending work;
  // assignment (not preemption) hands those tasks out, so reserve an idle
  // agent per pending task before reaching for a victim.
  const idleAgents = (await tx
    .select({ id: agents.id, caps: agents.capabilities })
    .from(agents)
    .where(
      and(
        eq(agents.projectId, projectId),
        inArray(agents.status, ['online', 'benchmarked']),
        sql`NOT EXISTS (SELECT 1 FROM ${tasks} WHERE ${tasks.agentId} = ${agents.id} AND ${tasks.status} IN ('assigned', 'running', 'paused'))`
      )
    )) as { id: number; caps: Caps }[]

  const availableIdle = [...idleAgents]
  const usedVictims = new Set<number>()
  const pausedIds: number[] = []

  for (const hp of pending) {
    // An idle matching agent will pick this up via assignment — no preemption.
    const idleIdx = availableIdle.findIndex((a) => agentCanRunTask(a.caps, hp.requiredCapabilities))
    if (idleIdx >= 0) {
      availableIdle.splice(idleIdx, 1)
      continue
    }

    // Lowest-priority strictly-lower-priority running task whose agent can
    // run this pending task, not already chosen as a victim this pass.
    const victim = running.find(
      (r) =>
        !usedVictims.has(r.id) &&
        r.priority > hp.priority &&
        agentCanRunTask(r.agentCaps, hp.requiredCapabilities)
    )
    if (!victim) continue

    const paused = await pauseVictim(tx, victim.id, projectId, hp.campaignId)
    if (!paused) continue

    usedVictims.add(victim.id)
    pausedIds.push(victim.id)
    await recordTaskEvent({
      taskId: victim.id,
      eventType: 'preempted',
      fromStatus: victim.status as 'running' | 'assigned',
      toStatus: 'paused',
      reason: 'preempted',
      byCampaignId: hp.campaignId,
    })
    emitTaskUpdate(projectId, victim.id, 'paused', {
      agentId: paused.agentId,
      campaignId: victim.campaignId,
    })
  }

  return pausedIds
}

/**
 * Resume pass placeholder — implemented in U6. Defined here so the worker
 * (U5) calls a stable `evaluatePreemption` shape across the two units.
 */
async function runResumePass(_tx: Tx, _projectId: number): Promise<number[]> {
  return []
}

/**
 * Evaluate and apply preemption for one project. Serialized per project via
 * a transaction-scoped advisory lock.
 */
export async function evaluatePreemption(projectId: number): Promise<PreemptionResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${PREEMPTION_LOCK_NAMESPACE}, ${projectId})`)
    const pausedTaskIds = await runPausePass(tx, projectId)
    const resumedTaskIds = await runResumePass(tx, projectId)
    if (pausedTaskIds.length > 0 || resumedTaskIds.length > 0) {
      logger.info(
        {
          event: 'preemption',
          projectId,
          paused: pausedTaskIds.length,
          resumed: resumedTaskIds.length,
        },
        'preemption evaluated'
      )
    }
    return { pausedTaskIds, resumedTaskIds }
  })
}
