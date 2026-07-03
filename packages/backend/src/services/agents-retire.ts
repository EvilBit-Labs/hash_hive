/**
 * Agent retirement (issue #106 U8).
 *
 * Extracted from `services/agents.ts` to keep that module's core
 * CRUD/heartbeat layer under the project's file-size guideline — mirrors
 * the relationship between `services/resources.ts` and
 * `services/resources-archive.ts` (and `services/campaigns.ts` /
 * `services/campaigns-attacks-archive.ts`). Re-exported through
 * `services/agents.js` so callers don't need a second import path.
 */
import { agents, tasks } from '@hashhive/shared'
import { and, eq, inArray, ne } from 'drizzle-orm'

import type { Actor } from './agents.js'

import { db } from '../db/index.js'
import { recordAuditEvent } from './audit-log.js'
import { emitAgentStatus, emitTaskUpdate } from './events.js'

/**
 * Typed outcome of `retireAgent`, mirroring the campaign/attack
 * archive-service convention (`{ kind }` discriminant, no thrown
 * exceptions for expected outcomes at the service boundary).
 */
export type RetireAgentResult =
  | { kind: 'retired'; agentId: number; releasedTaskIds: number[] }
  // Idempotent: the agent was already retired, either by an earlier call
  // or a concurrent one that won the race inside the transaction below.
  | { kind: 'already_retired' }
  | { kind: 'not_found' }

/**
 * Retire an agent: a terminal status flip with no restore path (unlike
 * the reversible archive/restore ADR-0019 pattern used by campaigns,
 * resources, and attacks). R8/R9: any task the agent currently holds
 * (`assigned`, `running`, or a preempted `paused` task that still carries
 * its `agent_id`) is released back to `pending` with `agent_id`
 * cleared so the scheduler can reassign it to another agent, and the
 * agent's row plus all of its history (tasks, benchmarks, errors) is
 * retained — nothing is deleted.
 *
 * CRITICAL (plan Risks / #106 U8): the status flip and the task release
 * run inside a SINGLE `db.transaction()`. Splitting them would open a
 * double-scheduling window against the preemption worker (a task could
 * be released while the agent row still reads a non-retired status, or
 * vice versa). This is new SQL that shares `pauseVictim`'s atomicity
 * pattern (`tasks/preemption.ts`) but is NOT a call to it: `pauseVictim`
 * is private, requires a `byCampaignId` (a preemptor to blame), and
 * deliberately *retains* `agent_id` so the heartbeat stop-signal stays
 * derivable. Retirement has none of those — the agent is gone for good,
 * so `agent_id` is cleared outright and, per R8, any partial progress on
 * the released tasks is discarded (workRange stays at its original
 * chunk boundaries; progress/lease/retry state resets to a clean pending
 * task) rather than trimmed-and-resumed the way preemption's `resumeTask`
 * does.
 */
export async function retireAgent(
  agentId: number,
  projectId: number,
  actor: Actor
): Promise<RetireAgentResult> {
  // Pre-check outside the transaction: best-effort classification so a
  // cross-project or unknown id short-circuits before opening a tx. The
  // transaction's guarded UPDATE re-enforces this atomically — the
  // pre-check can race and lose, which is handled below.
  const [oldRow] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.projectId, projectId)))
    .limit(1)

  if (!oldRow) return { kind: 'not_found' }
  if (oldRow.status === 'retired') return { kind: 'already_retired' }

  const txResult = await db.transaction(async (tx) => {
    // Atomic guard: the status-not-already-retired condition is folded
    // into the UPDATE WHERE (not read-then-write) so a concurrent retire
    // of the same agent can't double-fire the task release below.
    const [updatedAgent] = await tx
      .update(agents)
      .set({ status: 'retired', updatedAt: new Date() })
      .where(
        and(eq(agents.id, agentId), eq(agents.projectId, projectId), ne(agents.status, 'retired'))
      )
      .returning()

    if (!updatedAgent) {
      // Race: another caller retired this agent between the pre-check
      // and this UPDATE. Nothing to release — bail without touching tasks.
      return null
    }

    // Release every task this agent currently holds back to 'pending' so
    // the scheduler can reassign it. Scoped by agent_id only (not also
    // joined through campaigns.project_id like pauseVictim) because the
    // agent row was already verified to belong to `projectId` above —
    // every task referencing this agent_id is transitively project-scoped
    // through the agent, and a task's own campaign always shares the
    // agent's project (agents cannot be assigned cross-project work).
    const releasedTasks = await tx
      .update(tasks)
      .set({
        status: 'pending',
        agentId: null,
        assignedAt: null,
        startedAt: null,
        leaseExpiresAt: null,
        committedKeyspaceOffset: null,
        // R8: partial progress on preempted-by-retirement chunks is
        // discarded (unlike preemption's resumeTask, which trims
        // workRange by the reported progress and resumes from there).
        // The chunk is redone in full by whichever agent claims it next.
        progress: {},
        retryCount: 0,
        // A preempted task sits in `paused` while RETAINING its agent_id (so
        // the heartbeat stop-signal stays derivable). Retirement must release
        // those too, or they'd linger on the decommissioned agent until the
        // next resume sweep — clear the preemption metadata as we return them
        // to `pending` so the scheduler treats them as fresh claimable work.
        pausedReason: null,
        preemptedByCampaignId: null,
        pausedAt: null,
        resumedAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(eq(tasks.agentId, agentId), inArray(tasks.status, ['assigned', 'running', 'paused']))
      )
      .returning({ id: tasks.id, campaignId: tasks.campaignId })

    await recordAuditEvent(
      {
        actor,
        projectId,
        entityType: 'agent',
        entityId: agentId,
        action: 'retired',
        oldRow: oldRow as Record<string, unknown>,
        newRow: updatedAgent as Record<string, unknown>,
      },
      tx
    )

    return { updatedAgent, releasedTasks }
  })

  if (!txResult) {
    return { kind: 'already_retired' }
  }

  // Post-commit: emit SSE so connected dashboards drop the agent from the
  // active fleet view and pick up the reassignable tasks without waiting
  // for the next poll — same "emit after commit, never before" convention
  // as processHeartbeat / evaluatePreemption.
  emitAgentStatus(projectId, agentId, 'retired')
  for (const released of txResult.releasedTasks) {
    emitTaskUpdate(projectId, released.id, 'pending', {
      agentId: null,
      campaignId: released.campaignId,
    })
  }

  return {
    kind: 'retired',
    agentId,
    releasedTaskIds: txResult.releasedTasks.map((t) => t.id),
  }
}
