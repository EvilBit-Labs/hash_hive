import type { AssignedTask } from '@hashhive/shared'

import { agentBenchmarks, agents, attacks, campaigns, hashItems, tasks } from '@hashhive/shared'
import { and, desc, eq, inArray, type SQL, sql } from 'drizzle-orm'

import { env } from '../config/env.js'
import { logger } from '../config/logger.js'
import { db } from '../db/index.js'
import { updateAgentObservedRate } from './agent-rate.js'
import { getAgentBenchmarkForMode } from './agents.js'
import { computeAttackKeyspace } from './attacks/complexity.js'
import {
  enqueuePreemptionEvaluation,
  latchAttackPermanent,
  updateCampaignProgress,
} from './campaigns.js'
import { pickChunkSize, pickParcelSize } from './chunk-sizing.js'
import { emitCrackResult, emitTaskUpdate } from './events.js'
import { jsonSafeBigint, readWorkRangeField } from './tasks/_internals.js'
import { MAX_RETRIES } from './tasks/retry.js'
import { appendTaskTelemetry } from './telemetry.js'

// ─── Task Generation ────────────────────────────────────────────────

/**
 * Derives required capabilities from an attack's configuration.
 * Used when generating tasks so agents can be matched by capability.
 */
function deriveRequiredCapabilities(attack: {
  mode: number
  advancedConfiguration: unknown
}): Record<string, unknown> {
  const caps: Record<string, unknown> = {}
  const config = (attack.advancedConfiguration ?? {}) as Record<string, unknown>

  // Attacks requiring GPU acceleration
  if (config['useGpu'] === true) {
    caps['gpu'] = true
  }

  // Store the hashcat mode so agents can advertise supported modes
  caps['hashcatMode'] = attack.mode

  return caps
}

/**
 * Look up benchmarks recorded for the attack's hashcat mode across the
 * project's active agents. Used at generation time to size chunks against
 * the fleet's median throughput rather than a flat constant.
 *
 * The status filter intentionally includes 'busy' agents even though
 * `assignNextTask` only assigns work to 'online' / 'benchmarked' agents.
 * Busy agents are still part of the fleet's throughput profile - excluding
 * them would skew chunk sizing toward an artificially idle fleet right when
 * load is highest.
 *
 * Returns an empty array when no benchmarks are available - callers fall
 * back to the legacy FALLBACK_CHUNK_SIZE so fresh fleets don't regress.
 */
async function getFleetBenchmarksForMode(
  projectId: number,
  hashcatMode: number
): Promise<{ speedHs: number }[]> {
  return db
    .select({ speedHs: agentBenchmarks.speedHs })
    .from(agentBenchmarks)
    .innerJoin(agents, eq(agentBenchmarks.agentId, agents.id))
    .where(
      and(
        eq(agentBenchmarks.hashcatMode, hashcatMode),
        eq(agents.projectId, projectId),
        sql`${agents.status} IN ('online', 'benchmarked', 'busy')`
      )
    )
}

/**
 * Generates tasks for an attack by partitioning its keyspace into chunks.
 *
 * Chunking strategy:
 *   1. If `attack.keyspace` is missing, attempt to compute it from the
 *      attack's mode + wordlist/rule/mask metadata. If computation fails
 *      (unknown mode, missing required input), create a single placeholder
 *      task so the existing assignment path can still progress.
 *   2. Look up the project's fleet benchmarks for the attack's hashcat
 *      mode and pass the median to `pickChunkSize`. Empty fleet falls
 *      back to FALLBACK_CHUNK_SIZE.
 *   3. Walk the keyspace in bigint and emit one task per chunk.
 */
export async function generateTasksForAttack(
  attackId: number,
  opts: { chunkSize?: number | undefined } = {}
) {
  // Validate caller override up front: the chunk size feeds bigint division
  // at the projected-chunks check and the loop step. Zero, negative, NaN,
  // Infinity, or non-integer values would either throw inside `BigInt()`
  // or trigger division-by-zero / produce a non-terminating chunk walk.
  if (opts.chunkSize !== undefined) {
    if (
      !Number.isFinite(opts.chunkSize) ||
      !Number.isInteger(opts.chunkSize) ||
      opts.chunkSize <= 0
    ) {
      throw new Error(
        `generateTasksForAttack: opts.chunkSize must be a positive integer, got ${String(opts.chunkSize)}`
      )
    }
  }

  const [attack] = await db.select().from(attacks).where(eq(attacks.id, attackId)).limit(1)
  if (!attack) {
    return { error: 'Attack not found' }
  }

  const requiredCapabilities = deriveRequiredCapabilities(attack)

  // Resolve total keyspace: prefer the stored value; compute when missing.
  let totalKeyspaceStr = attack.keyspace?.trim() ?? ''
  if (!totalKeyspaceStr || totalKeyspaceStr === '0') {
    const computed = await computeAttackKeyspace(attack)
    totalKeyspaceStr = computed ?? ''
  }

  const totalKeyspace = totalKeyspaceStr ? BigInt(totalKeyspaceStr) : 0n
  if (totalKeyspace <= 0n) {
    // No keyspace available - emit a single placeholder task so downstream
    // assignment / progress / failure paths still have a row to operate on.
    // Insert + permanence latch (ADR-0019 / issue #106 U6) run in one
    // transaction: this is the attack's first task row, so a crash between
    // the two could otherwise leave a run attack un-latched (deletable).
    const [task] = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(tasks)
        .values({
          attackId: attack.id,
          campaignId: attack.campaignId,
          status: 'pending',
          workRange: { start: 0, end: 0, total: 0 },
          requiredCapabilities,
        })
        .returning()
      await latchAttackPermanent(tx, attack.id)
      return inserted
    })

    return { tasks: [task], count: 1 }
  }

  // Decide chunk size - caller override beats fleet-aware sizing for tests.
  let chunkSize: bigint
  if (opts.chunkSize !== undefined) {
    chunkSize = BigInt(opts.chunkSize)
  } else {
    const benchmarks = await getFleetBenchmarksForMode(attack.projectId, attack.mode)
    chunkSize = BigInt(pickChunkSize({ totalKeyspace: totalKeyspaceStr, benchmarks }))
  }

  // Cap chunk count to bound memory + DB-row inserts. A `?a^12` mask attack
  // (~5.4e23 keyspace) at MAX_CHUNK_SIZE (1e9) would otherwise materialize
  // ~5.4e14 task rows and OOM the process. When the floor lifts chunkSize
  // past MAX_CHUNK_SIZE, the caller-visible truncation is the only way to
  // keep generation finite - the trailing remainder becomes a single
  // oversized task that the heartbeat-monitor rebalance branch will split
  // further as agents make progress against it.
  const maxChunks = BigInt(MAX_CHUNKS_PER_ATTACK)
  // Ceiling-div: the actual loop emits `ceil(totalKeyspace / chunkSize)`
  // chunks, so the comparison must use the same ceiling. With plain floor
  // div, `totalKeyspace = MAX*chunkSize + 1` would test as `> MAX_CHUNKS`
  // false (floor div gives exactly MAX) but the loop would emit MAX+1
  // chunks, blowing past the documented cap.
  const projectedChunks = totalKeyspace / chunkSize + (totalKeyspace % chunkSize === 0n ? 0n : 1n)
  if (projectedChunks > maxChunks) {
    chunkSize = totalKeyspace / maxChunks
    if (totalKeyspace % maxChunks !== 0n) chunkSize += 1n
  }

  const chunks: Array<{
    start: number | string
    end: number | string
    total: number | string
  }> = []
  for (let start = 0n; start < totalKeyspace; start += chunkSize) {
    const end = start + chunkSize > totalKeyspace ? totalKeyspace : start + chunkSize
    chunks.push({
      start: jsonSafeBigint(start),
      end: jsonSafeBigint(end),
      total: jsonSafeBigint(end - start),
    })
  }

  // Insert + permanence latch (ADR-0019 / issue #106 U6) run in one
  // transaction — see the placeholder-task branch above for why. The
  // guarded `WHERE isPermanent = false` inside the latch makes a
  // re-generation run (attack already permanent) a no-op.
  const createdTasks = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(tasks)
      .values(
        chunks.map((range) => ({
          attackId: attack.id,
          campaignId: attack.campaignId,
          status: 'pending' as const,
          workRange: range,
          requiredCapabilities,
        }))
      )
      .returning()
    await latchAttackPermanent(tx, attack.id)
    return inserted
  })

  return { tasks: createdTasks, count: createdTasks.length }
}

// ─── Task Assignment ────────────────────────────────────────────────

/**
 * Builds a SQL predicate that checks whether the agent's capabilities satisfy
 * a task's required_capabilities column at the database level.
 *
 * Covers:
 * - GPU requirement: task requires `gpu: true` → agent capabilities must contain `{"gpu": true}`
 * - Hash mode compatibility: task's `hashcatMode` value must be in agent's `hashModes` array
 */
export function buildCapabilityPredicate(agentCaps: Record<string, unknown>): SQL {
  const hasGpu = agentCaps['gpu'] === true
  const rawHashModes = Array.isArray(agentCaps['hashModes']) ? agentCaps['hashModes'] : []
  // Sanitize to finite integers only — NaN, Infinity, non-numeric strings are dropped
  const hashModes = rawHashModes
    .map((m: unknown) => Number(m))
    .filter((n): n is number => Number.isFinite(n) && Number.isInteger(n))

  // GPU check: if the task requires GPU, the agent must have it.
  // If the agent has GPU, this is always satisfied. If not, exclude GPU-requiring tasks.
  const gpuCondition = hasGpu
    ? sql`TRUE`
    : sql`NOT (${tasks.requiredCapabilities}->>'gpu' = 'true')`

  // Hash mode check: the task's required hashcatMode must be in the agent's hashModes array.
  // If agent advertises no hashModes (or all were invalid), only tasks without a hashcatMode requirement pass.
  // Build the int[] as an inline ARRAY literal rather than a bound JS-array
  // parameter: postgres.js mis-binds a JS array passed for `::int[]`
  // (ERR_INVALID_ARG_TYPE on the array elements). `hashModes` is already
  // sanitized to finite integers above, so interpolating them as a literal is
  // injection-safe. Surfaced by the U13 real-DB lane (mocked tests never bound
  // a real array).
  const hashModeCondition =
    hashModes.length > 0
      ? sql`(
          ${tasks.requiredCapabilities}->>'hashcatMode' IS NULL
          OR (${tasks.requiredCapabilities}->>'hashcatMode')::int = ANY(${sql.raw(`ARRAY[${hashModes.join(',')}]`)}::int[])
        )`
      : sql`(${tasks.requiredCapabilities}->>'hashcatMode' IS NULL)`

  return sql`(${gpuCondition} AND ${hashModeCondition})`
}

const DEFAULT_AGENT_SPEED_HS = 1_000_000 // 1 MH/s fallback when no benchmark exists

// Hard cap on tasks per attack — bounds memory + row count at generation time
// and at claim-time split. Both `generateTasksForAttack` and the split-on-claim
// remainder INSERT enforce it so the two paths can never disagree.
const MAX_CHUNKS_PER_ATTACK = 100_000

/**
 * When `assignNextTask`'s atomic claim returns no rows, decide why so the
 * structured log entry carries actionable signal. Three possible reasons:
 *   - `no_pending_tasks`: project has zero pending+unassigned tasks at all
 *   - `no_matching_capability`: pending tasks exist but none satisfy the
 *     agent's capability predicate
 *   - `claim_race_lost`: matching tasks exist but every candidate was locked
 *     by a peer claimant via SKIP LOCKED in the same tick
 */
async function diagnoseAssignmentSkip(
  projectId: number,
  capabilityPredicate: SQL
): Promise<'no_pending_tasks' | 'no_matching_capability' | 'claim_race_lost'> {
  // Count pending+unassigned tasks for the project regardless of capability.
  const [pendingTotal] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(tasks)
    .innerJoin(campaigns, eq(tasks.campaignId, campaigns.id))
    .where(
      and(
        eq(tasks.status, 'pending'),
        sql`${tasks.agentId} IS NULL`,
        eq(campaigns.projectId, projectId)
      )
    )
  if (!pendingTotal || pendingTotal.n === 0) {
    return 'no_pending_tasks'
  }

  // Count pending+unassigned tasks the agent's capabilities actually match.
  const [matching] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(tasks)
    .innerJoin(campaigns, eq(tasks.campaignId, campaigns.id))
    .where(
      and(
        eq(tasks.status, 'pending'),
        sql`${tasks.agentId} IS NULL`,
        eq(campaigns.projectId, projectId),
        capabilityPredicate
      )
    )
  if (!matching || matching.n === 0) {
    return 'no_matching_capability'
  }

  // Matching candidates exist but the CTE returned zero rows - every
  // candidate must have been locked by a concurrent claimant.
  return 'claim_race_lost'
}

/**
 * Skip reasons emitted by `assignNextTask` when no task is assigned. Each one
 * appears in the structured `task_assignment` log so operators can debug
 * fleet utilization without reading the DB by hand.
 */
type AssignmentSkipReason =
  | 'agent_not_eligible' // agent missing, offline, or status outside the eligible set
  | 'no_pending_tasks' // project has no pending tasks at all
  | 'no_matching_capability' // pending tasks exist but none match the agent's caps
  | 'claim_race_lost' // candidate locked by another claimant via SKIP LOCKED

function logAssignmentSkip(
  agentId: number,
  projectId: number | null,
  reason: AssignmentSkipReason
): void {
  logger.info(
    { event: 'task_assignment', kind: 'skipped', agentId, projectId, reason },
    'task assignment skipped'
  )
}

function logAssignmentSuccess(agentId: number, projectId: number, taskId: number): void {
  logger.info(
    { event: 'task_assignment', kind: 'assigned', agentId, projectId, taskId },
    'task assigned'
  )
}

/**
 * Assigns the next available pending task to an agent.
 *
 * All eligibility filters (project scope, capability match) are enforced
 * in the SQL predicate. Uses `FOR UPDATE SKIP LOCKED` to guarantee only
 * one claimant atomically selects and claims a task row, even under
 * concurrent access from multiple agents.
 *
 * Returns `null` for every non-assignment outcome (no agent, no work,
 * race lost). The public return contract is unchanged; the operator-
 * facing diagnostic is the structured `task_assignment` info log.
 */
export async function assignNextTask(
  agentId: number,
  opts: {
    /**
     * Test-only hook (issue #106 F1 code review) invoked after the
     * eligibility pre-check SELECT resolves but before the atomic claim
     * statement runs. Lets DB-lane tests deterministically prove the
     * retire-vs-claim race is closed: mutate the agent's status
     * (simulating a concurrent retire landing in the gap) inside the
     * hook, then assert the claim statement's EXISTS guard sees the
     * mutated status and claims nothing. No-op by default — production
     * callers never pass this. Mirrors
     * `queue/workers/blob-reclamation.ts`'s `onBeforeStamp`.
     */
    onBeforeClaim?: () => Promise<void>
  } = {}
): Promise<AssignedTask | null> {
  // Verify agent exists and is online or benchmarked
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1)
  if (!agent || (agent.status !== 'online' && agent.status !== 'benchmarked')) {
    logAssignmentSkip(agentId, agent?.projectId ?? null, 'agent_not_eligible')
    return null
  }

  if (opts.onBeforeClaim) {
    await opts.onBeforeClaim()
  }

  const projectId = agent.projectId
  const agentCaps = (agent.capabilities ?? {}) as Record<string, unknown>
  const capabilityPredicate = buildCapabilityPredicate(agentCaps)

  const leaseDurationMs = env.TASK_LEASE_DURATION_MS

  // Atomic candidate selection + claim via raw SQL with FOR UPDATE SKIP LOCKED.
  //
  // U11 (KTD-5): The candidate predicate now covers two cases:
  //   1. Truly idle tasks (pending, no owner).
  //   2. Expired-lease tasks (assigned/running but lease_expires_at < NOW()).
  //
  // A NOT EXISTS subquery enforces the one-active-lease-per-agent invariant:
  // an agent that already holds a live lease cannot claim a second task.
  //
  // The SET clause stamps a fresh lease_expires_at so the lessee must report
  // progress within TASK_LEASE_DURATION_MS or lose the task to reclaim.
  //
  // F1 (issue #106 code review): the eligibility check above (lines
  // 359-364) is a plain unlocked SELECT — an admin retiring this agent can
  // commit between that SELECT and this statement. Re-checking eligibility
  // via an EXISTS subquery folded into THIS statement's WHERE closes the
  // race: the claim and the eligibility check now read the agent's status
  // from the same statement snapshot as the UPDATE that assigns the task,
  // so a retire that commits before this statement starts makes the EXISTS
  // false and the whole candidate CTE returns zero rows — no claim happens.
  const result = await db.execute(sql`
    WITH candidate AS (
      SELECT ${tasks.id} AS task_id,
             ${tasks.status} AS prior_status,
             ${tasks.committedKeyspaceOffset} AS committed_offset
      FROM ${tasks}
      INNER JOIN ${campaigns} ON ${tasks.campaignId} = ${campaigns.id}
      WHERE (
        (${tasks.status} = 'pending' AND ${tasks.agentId} IS NULL)
        OR (
          ${tasks.status} IN ('assigned', 'running')
          AND ${tasks.leaseExpiresAt} < NOW()
          -- U12: a task reclaimed MAX_RETRIES times without progress is a poison
          -- task; stop reclaiming it so the backstop can fail it terminally.
          AND ${tasks.retryCount} < ${MAX_RETRIES}
        )
      )
        AND ${campaigns.projectId} = ${projectId}
        AND ${capabilityPredicate}
        AND EXISTS (
          SELECT 1 FROM ${agents}
          WHERE ${agents.id} = ${agentId}
            AND ${agents.status} IN ('online', 'benchmarked')
        )
        AND NOT EXISTS (
          SELECT 1 FROM ${tasks} t2
          WHERE t2.agent_id = ${agentId}
            AND t2.status IN ('assigned', 'running')
            AND t2.lease_expires_at > NOW()
        )
      ORDER BY ${campaigns.priority}, ${tasks.id}
      LIMIT 1
      FOR UPDATE OF ${tasks} SKIP LOCKED
    )
    UPDATE ${tasks}
    SET
      agent_id = ${agentId},
      status = 'assigned',
      assigned_at = NOW(),
      updated_at = NOW(),
      lease_expires_at = NOW() + (${leaseDurationMs}::bigint * INTERVAL '1 millisecond'),
      -- U12: on RECLAIM (prior status assigned/running), resume from the
      -- committed offset so only un-committed keyspace is redone. committed_offset
      -- is an ABSOLUTE coordinate in the same space as workRange.start, so it is
      -- written straight into work_range.start (as text to preserve bigint-scale
      -- precision; readers accept number|string). total is rebased to
      -- (end - committed_offset) so the remaining range is reported correctly.
      -- A NULL committed_offset (no prior progress) leaves the range unchanged.
      work_range = CASE
        WHEN candidate.prior_status IN ('assigned', 'running') AND candidate.committed_offset IS NOT NULL
          THEN jsonb_set(
                 jsonb_set(${tasks.workRange}, '{start}', to_jsonb(candidate.committed_offset::text)),
                 '{total}',
                 to_jsonb((((${tasks.workRange} ->> 'end')::numeric) - (candidate.committed_offset::numeric))::text)
               )
        ELSE ${tasks.workRange}
      END,
      -- U12 (coordinate-frame fix): reset progress.keyspaceProgress to 0 on
      -- reclaim. keyspaceProgress is RELATIVE to work_range.start; rebasing start
      -- to the committed offset without resetting it would leave the stale
      -- old-agent value, so the watermark predicate (which compares the resuming
      -- agent's fresh near-zero reports against tasks.progress) would read "no
      -- advance", failing to extend the lease (risking a false reclaim loop) and
      -- failing to reset retry_count. Zeroing it gives the new agent a clean
      -- baseline. Other progress fields (speed/temperature) are preserved.
      progress = CASE
        WHEN candidate.prior_status IN ('assigned', 'running') AND candidate.committed_offset IS NOT NULL
          THEN jsonb_set(COALESCE(${tasks.progress}, '{}'::jsonb), '{keyspaceProgress}', '0'::jsonb)
        ELSE ${tasks.progress}
      END,
      -- U12: count a retry on every reclaim; updateTaskProgress resets it to 0
      -- when the watermark advances, so only no-progress reclaims accumulate.
      retry_count = CASE
        WHEN candidate.prior_status IN ('assigned', 'running')
          THEN ${tasks.retryCount} + 1
        ELSE ${tasks.retryCount}
      END
    FROM candidate
    WHERE ${tasks.id} = candidate.task_id
    RETURNING ${tasks.id}, ${tasks.attackId}, ${tasks.campaignId}, ${tasks.agentId},
              ${tasks.status}, ${tasks.workRange}, ${tasks.progress}, ${tasks.resultStats},
              ${tasks.requiredCapabilities}, ${tasks.assignedAt}, ${tasks.startedAt},
              ${tasks.completedAt}, ${tasks.failureReason}, ${tasks.retryCount},
              ${tasks.createdAt}, ${tasks.updatedAt}
  `)

  const row = result[0] as Record<string, unknown> | undefined
  if (!row) {
    // Distinguish "nothing pending in this project" from "pending exists
    // but none match this agent" from "candidate locked by a peer". The
    // additional queries are cheap (one index hit per skip event) and
    // give operators the signal they need to debug fleet utilization.
    //
    // Best-effort: if the diagnostic itself errors (e.g. a transient DB
    // issue), still emit a skip log with a generic reason rather than
    // turning the diagnostic into a new failure mode.
    let reason: AssignmentSkipReason = 'claim_race_lost'
    try {
      // F1: a zero-row result can now also mean the CTE's agent-eligibility
      // EXISTS check lost the race (the agent was retired/offlined between
      // the pre-check above and this statement). Re-check eligibility first
      // so that case is reported accurately instead of the generic
      // task-contention diagnosis.
      const [currentAgent] = await db
        .select({ status: agents.status })
        .from(agents)
        .where(eq(agents.id, agentId))
        .limit(1)
      if (
        !currentAgent ||
        (currentAgent.status !== 'online' && currentAgent.status !== 'benchmarked')
      ) {
        reason = 'agent_not_eligible'
        logAssignmentSkip(agentId, projectId, reason)
        return null
      }
      reason = await diagnoseAssignmentSkip(projectId, capabilityPredicate)
    } catch (err: unknown) {
      logger.warn(
        { err, agentId, projectId },
        'assignment skip diagnosis failed; logging claim_race_lost as best guess'
      )
    }
    logAssignmentSkip(agentId, projectId, reason)
    return null
  }
  logAssignmentSuccess(agentId, projectId, row['id'] as number)

  // Extract hashcatMode from the task's required capabilities for benchmark lookup
  // Accept both numeric and numeric-string values (legacy/external inserts may store as string)
  const requiredCaps = row['required_capabilities'] as Record<string, unknown> | null
  const rawHashcatMode = requiredCaps?.['hashcatMode']
  const parsedMode =
    typeof rawHashcatMode === 'number'
      ? rawHashcatMode
      : typeof rawHashcatMode === 'string'
        ? Number(rawHashcatMode)
        : Number.NaN
  const taskHashcatMode =
    Number.isFinite(parsedMode) && Number.isInteger(parsedMode) ? parsedMode : null

  // Look up the agent's benchmark speed for this hash mode.
  // Wrapped in try-catch because the task is already claimed via FOR UPDATE SKIP LOCKED -
  // a benchmark lookup failure must not orphan the assigned task.
  let agentSpeedHs = DEFAULT_AGENT_SPEED_HS
  // U13: the rate used to size the claim-time parcel. Prefers the live
  // observed-speed EWMA (U6); falls back to the static registration benchmark,
  // then DEFAULT_AGENT_SPEED_HS on cold start so a null/zero rate never produces
  // BigInt(NaN) or a starved 0-size parcel.
  let sizingSpeedHs = DEFAULT_AGENT_SPEED_HS
  if (taskHashcatMode !== null) {
    try {
      const benchmark = await getAgentBenchmarkForMode(agentId, taskHashcatMode)
      if (benchmark) {
        agentSpeedHs = benchmark.speedHs
        const observed = benchmark.observedSpeedHs
        sizingSpeedHs =
          observed != null && observed > 0
            ? observed
            : benchmark.speedHs > 0
              ? benchmark.speedHs
              : DEFAULT_AGENT_SPEED_HS
      }
    } catch (err: unknown) {
      logger.warn(
        { err, agentId, hashcatMode: taskHashcatMode },
        'Benchmark lookup failed after task assignment - using default speed'
      )
    }
  }

  // U13 split-on-claim: if the claimed range exceeds a target-duration parcel at
  // this agent's rate, trim this task to the parcel and re-pend the remainder as
  // a new pending task — atomically, so a remainder-insert failure rolls back the
  // trim and leaves the claimed task whole (no lost keyspace). Generation-time
  // sizing can stay coarse since claim-time split now adapts per agent.
  const claimedRange = (row['work_range'] as {
    start: number | string
    end: number | string
    total: number | string
  } | null) ?? { start: 0, end: 0, total: 0 }
  let finalRange: { start: number | string; end: number | string; total: number | string } =
    claimedRange
  const claimStart = readWorkRangeField(claimedRange, 'start')
  const claimEnd = readWorkRangeField(claimedRange, 'end')
  const remaining = claimEnd > claimStart ? claimEnd - claimStart : 0n
  if (remaining > 0n) {
    const parcel = BigInt(
      pickParcelSize(sizingSpeedHs, env.TASK_TARGET_DURATION_SECONDS, remaining)
    )
    if (parcel < remaining) {
      const parcelEnd = claimStart + parcel
      const trimmed = {
        start: jsonSafeBigint(claimStart),
        end: jsonSafeBigint(parcelEnd),
        total: jsonSafeBigint(parcel),
      }
      const remainder = {
        start: jsonSafeBigint(parcelEnd),
        end: jsonSafeBigint(claimEnd),
        total: jsonSafeBigint(claimEnd - parcelEnd),
      }
      const splitAttackId = row['attack_id'] as number
      const remainderJson = JSON.stringify(remainder)
      const capsJson = JSON.stringify(
        (row['required_capabilities'] as Record<string, unknown> | null) ?? {}
      )
      try {
        const didSplit = await db.transaction(async (tx) => {
          // Atomic MAX_CHUNKS_PER_ATTACK guard: insert the remainder only if the
          // attack is under the cap, checked in the SAME statement (the count
          // subquery in the INSERT WHERE) so two concurrent claims can't both
          // exceed it. RETURNING is empty when the cap is hit -> no remainder,
          // and the claimed task keeps its full range.
          const inserted = await tx.execute(sql`
            INSERT INTO tasks (attack_id, campaign_id, status, work_range, required_capabilities)
            SELECT ${splitAttackId}, ${row['campaign_id'] as number}, 'pending',
                   ${remainderJson}::jsonb, ${capsJson}::jsonb
            WHERE (SELECT count(*) FROM tasks WHERE attack_id = ${splitAttackId}) < ${MAX_CHUNKS_PER_ATTACK}
            RETURNING id
          `)
          if (inserted.length === 0) {
            return false // at the cap — assign the whole range, no split
          }
          await tx
            .update(tasks)
            .set({ workRange: trimmed })
            .where(eq(tasks.id, row['id'] as number))
          return true
        })
        if (didSplit) {
          finalRange = trimmed
        }
      } catch (err: unknown) {
        // The split is best-effort: the task is already claimed (the CTE
        // committed). If the trim+remainder transaction fails it rolls back
        // atomically — the claimed task keeps its FULL range and no orphan
        // remainder is created (no lost keyspace). Assign the whole range rather
        // than failing the claim; the heartbeat rebalance can re-split later.
        logger.warn(
          { err, taskId: row['id'], agentId },
          'split-on-claim failed; assigning the full claimed range (no keyspace lost)'
        )
      }
    }
  }

  // Map snake_case DB columns back to camelCase to preserve the public API contract
  return {
    id: row['id'] as number,
    attackId: row['attack_id'] as number,
    campaignId: row['campaign_id'] as number,
    agentId: row['agent_id'] as number,
    status: row['status'] as string,
    workRange: {
      // U13: finalRange is the trimmed parcel when split-on-claim fired, else
      // the full claimed range.
      ...finalRange,
      agentSpeedHs,
    },
    progress: row['progress'],
    resultStats: row['result_stats'],
    requiredCapabilities:
      (row['required_capabilities'] as AssignedTask['requiredCapabilities']) ?? null,
    assignedAt: row['assigned_at'] as Date | null,
    startedAt: row['started_at'] as Date | null,
    completedAt: row['completed_at'] as Date | null,
    failureReason: row['failure_reason'] as string | null,
    retryCount: row['retry_count'] as number,
    createdAt: row['created_at'] as Date,
    updatedAt: row['updated_at'] as Date,
  }
}

// ─── Task Progress & Results ────────────────────────────────────────

export async function updateTaskProgress(
  taskId: number,
  agentId: number,
  data: {
    status: string
    progress?:
      | {
          keyspaceProgress?: number | string | undefined
          speed?: number | undefined
          temperature?: number | undefined
        }
      | undefined
    results?: Array<{ hashValue: string; plaintext: string }> | undefined
  }
) {
  // Single JOIN: verify task ownership and resolve campaign context in one query
  const [taskRow] = await db
    .select({
      taskId: tasks.id,
      attackId: tasks.attackId,
      campaignId: tasks.campaignId,
      status: tasks.status,
      startedAt: tasks.startedAt,
      projectId: campaigns.projectId,
      hashListId: campaigns.hashListId,
      // Extract the hashcat mode stored in required_capabilities at task
      // generation time (deriveRequiredCapabilities sets caps['hashcatMode']).
      // Cast to int; null when the JSONB key is absent.
      hashcatMode: sql<number | null>`(${tasks.requiredCapabilities} ->> 'hashcatMode')::int`,
    })
    .from(tasks)
    .innerJoin(campaigns, eq(tasks.campaignId, campaigns.id))
    .where(and(eq(tasks.id, taskId), eq(tasks.agentId, agentId)))
    .limit(1)

  if (!taskRow) {
    return { error: 'Task not found or not assigned to this agent' }
  }

  // Persist-first (U5, KTD-8): move the hash_items upsert ABOVE the paused
  // guard so preemption or agent death between report and ack never drops a
  // found plaintext. The upsert is idempotent on (hash_list_id, hash_value),
  // so persisting before the guard is safe to repeat on resume.
  //
  // The hashListId-missing guard stays ahead of the insert: a campaign with no
  // hash list still surfaces the configuration error immediately (no insert).
  //
  // Attribution side-effects (emitCrackResult) remain gated on the
  // ownership-verifying UPDATE below — if the UPDATE matches zero rows
  // (task paused or reassigned), the plaintext is already persisted but no
  // crack event fires and no cursor advances. This closes the TOCTOU gap that
  // moving the insert alone would open: a concurrently cancelled task still
  // gets its plaintext saved, but does not generate a misattributed event.
  //
  // The hash_items FK to tasks is ON DELETE SET NULL, so a concurrent task
  // delete leaves the plaintext with a null task_id rather than an FK error.
  if (data.results && data.results.length > 0 && !taskRow.hashListId) {
    logger.error(
      {
        taskId,
        campaignId: taskRow.campaignId,
        resultCount: data.results.length,
      },
      'Cannot store crack results: campaign has no associated hash list'
    )
    return {
      error:
        'Campaign has no associated hash list; cracked results cannot be stored. Check campaign configuration before resubmitting.',
    }
  }

  if (data.results && data.results.length > 0 && taskRow.hashListId) {
    try {
      await db
        .insert(hashItems)
        .values(
          data.results.map((r) => ({
            hashListId: taskRow.hashListId,
            hashValue: r.hashValue,
            plaintext: r.plaintext,
            crackedAt: new Date(),
            campaignId: taskRow.campaignId,
            attackId: taskRow.attackId,
            taskId,
            agentId,
          }))
        )
        .onConflictDoUpdate({
          target: [hashItems.hashListId, hashItems.hashValue],
          set: {
            plaintext: sql`EXCLUDED.plaintext`,
            crackedAt: sql`EXCLUDED.cracked_at`,
            campaignId: sql`EXCLUDED.campaign_id`,
            attackId: sql`EXCLUDED.attack_id`,
            taskId: sql`EXCLUDED.task_id`,
            agentId: sql`EXCLUDED.agent_id`,
          },
        })
    } catch (err) {
      logger.error(
        {
          err,
          taskId,
          agentId,
          hashListId: taskRow.hashListId,
          resultCount: data.results.length,
        },
        'Failed to insert crack results'
      )
      return { error: 'Failed to store crack results' }
    }
  }

  // Preemption (#97 U4): a paused task still carries this agent_id (so the
  // heartbeat stop-signal stays derivable), but the agent is reporting
  // progress on work it should abandon. Do NOT resurrect the row to the
  // reported status — tell the agent to stop. The status guard folded into
  // the UPDATE below closes the residual TOCTOU window where a pause lands
  // between this read and the write.
  //
  // Crack results from a paused report are now persisted above (U5) before
  // reaching this guard, so no plaintext is dropped on the abandon path.
  if (taskRow.status === 'paused') {
    return { stopped: true as const }
  }

  const updates: Record<string, unknown> = {
    status: data.status,
    updatedAt: new Date(),
  }

  // NOTE (U9 deferred): this hot-row `progress` write is intentionally still
  // here. U4 made it a dual-write alongside the telemetry INSERT; U9 was to
  // remove it and cut reads to telemetry, but the read-cutover blast radius is
  // larger than planned — preemption.ts and attacks/runtime.ts read
  // tasks.progress for live keyspace position and must first migrate to
  // committed_keyspace_offset. Until that lands, the dual-write stays (the
  // plan's safe window). See task U9 / the PR's deferred-work section.
  if (data.progress) {
    updates['progress'] = data.progress
  }

  if (data.status === 'running' && !taskRow.startedAt) {
    updates['startedAt'] = new Date()
  }

  if (data.status === 'completed' || data.status === 'exhausted') {
    updates['completedAt'] = new Date()
  }

  // U11 (KTD-5): extend the lease only when the keyspace watermark strictly
  // advances. The CASE expression evaluates the OLD progress JSONB value
  // (PostgreSQL guarantees SET RHS sees the pre-update row) so the comparison
  // is always against the previously committed position.
  //
  // Binding as a string and casting ::numeric avoids JS number precision loss
  // on bigint-scale keyspace positions.
  const rawKp = data.progress?.keyspaceProgress
  const kpIsFinite =
    rawKp != null &&
    (typeof rawKp === 'number' ? Number.isFinite(rawKp) : String(rawKp).trim() !== '')
  if (kpIsFinite) {
    const kpStr = String(rawKp)
    const leaseDurationMs = env.TASK_LEASE_DURATION_MS
    // The "watermark advanced" predicate, reused below. `keyspaceProgress` in the
    // report is RELATIVE to this task's range; the stored progress JSONB holds the
    // previously committed relative position. SET RHS sees the pre-update row.
    const watermarkAdvanced = sql`COALESCE((${tasks.progress} ->> 'keyspaceProgress')::numeric, -1) < ${kpStr}::numeric`
    updates['leaseExpiresAt'] = sql`
      CASE
        WHEN ${watermarkAdvanced}
          THEN NOW() + (${leaseDurationMs}::bigint * INTERVAL '1 millisecond')
        ELSE ${tasks.leaseExpiresAt}
      END`
    // U12: advance the committed-offset cursor. It is an ABSOLUTE keyspace
    // coordinate — the same space as workRange.start — NOT the relative
    // `keyspaceProgress`. absolute = workRange.start + keyspaceProgress.
    // GREATEST keeps it monotonic against out-of-order reports. ::numeric for
    // the arithmetic (bigint-scale mask keyspaces), ::bigint for the column.
    updates['committedKeyspaceOffset'] = sql`
      GREATEST(
        COALESCE(${tasks.committedKeyspaceOffset}, 0)::numeric,
        COALESCE((${tasks.workRange} ->> 'start')::numeric, 0) + ${kpStr}::numeric
      )::bigint`
    // U12 (poison-task resolution, carried from U11): a report that advances the
    // watermark is healthy progress, so reset retry_count to 0. Only reclaims
    // that make NO progress accumulate retries toward MAX_RETRIES (incremented in
    // the assignNextTask reclaim branch), so a legitimate resume is never
    // penalized while a task no agent can progress eventually fails.
    updates['retryCount'] = sql`
      CASE WHEN ${watermarkAdvanced} THEN 0 ELSE ${tasks.retryCount} END`
  }

  // Update task status and append one telemetry row in a single transaction
  // so the two stores never diverge. The status guard (TOCTOU defense for
  // #97 U4) means a row paused between the read above and this write is
  // left untouched rather than resurrected to the reported status.
  //
  // U11 lapsed-lease race guard: add (lease_expires_at IS NULL OR
  // lease_expires_at > NOW()) so a late report from an agent whose lease
  // already expired matches zero rows — a no-op — rather than resurrecting
  // stale state. IS NULL keeps legacy pre-U10 rows (no lease column) updatable.
  const [updated] = await db.transaction(async (tx) => {
    const rows = await tx
      .update(tasks)
      .set(updates)
      .where(
        and(
          eq(tasks.id, taskId),
          eq(tasks.agentId, agentId),
          inArray(tasks.status, ['assigned', 'running']),
          sql`(${tasks.leaseExpiresAt} IS NULL OR ${tasks.leaseExpiresAt} > NOW())`
        )
      )
      .returning()

    if (rows[0]) {
      await appendTaskTelemetry(tx, {
        taskId,
        agentId,
        keyspaceProgress: data.progress?.keyspaceProgress,
        speedHs: data.progress?.speed ?? null,
        temperature: data.progress?.temperature ?? null,
      })
    }

    return rows
  })

  if (!updated) {
    return { error: 'Task was reassigned during update' }
  }

  // Attribution: fire the crack event only when the ownership-verifying UPDATE
  // confirmed this agent still owns the task. The plaintext was already
  // persisted above regardless — this call attributes the find to the live task.
  if (data.results && data.results.length > 0 && taskRow.hashListId) {
    emitCrackResult(taskRow.projectId, taskRow.hashListId, data.results.length)
  }

  // U6: update per-agent observed-rate EWMA from the reported speed.
  // Gated on: ownership confirmed (updated is truthy), running status,
  // a finite positive speed sample, and a resolved hashcatMode.
  // Observe-only — a failure here must never break the report.
  if (
    data.status === 'running' &&
    data.progress?.speed != null &&
    Number.isFinite(data.progress.speed) &&
    data.progress.speed > 0 &&
    taskRow.hashcatMode != null
  ) {
    updateAgentObservedRate(agentId, taskRow.hashcatMode, data.progress.speed).catch((err) => {
      logger.warn(
        { err, agentId, hashcatMode: taskRow.hashcatMode, speed: data.progress?.speed },
        'Failed to update agent observed rate EWMA (non-fatal)'
      )
    })
  }

  // Emit events and update campaign progress (no duplicate campaign fetch)
  emitTaskUpdate(taskRow.projectId, taskId, data.status, {
    agentId,
    campaignId: taskRow.campaignId,
    progress: data.progress,
  })
  await updateCampaignProgress(taskRow.campaignId)

  // A task reaching a terminal state frees its agent — re-evaluate
  // preemption so paused lower-priority victims can resume (#97 U6
  // completion trigger). Best-effort; never fails the report.
  if (data.status === 'completed' || data.status === 'exhausted') {
    await enqueuePreemptionEvaluation(taskRow.projectId)
  }

  return { task: updated }
}

// ─── Task Queries ───────────────────────────────────────────────────

/**
 * Fetch a task by id, scoped to a project. Joins through campaigns to
 * derive project ownership (tasks do not carry projectId directly).
 * Returns null when the task does not exist OR when it belongs to a
 * different project — a defense-in-depth guard that keeps cross-project
 * enumeration impossible even if a caller forgets the boundary check.
 */
export async function getTaskById(id: number, projectId: number) {
  const [row] = await db
    .select({ task: tasks })
    .from(tasks)
    .innerJoin(campaigns, eq(tasks.campaignId, campaigns.id))
    .where(and(eq(tasks.id, id), eq(campaigns.projectId, projectId)))
    .limit(1)
  return row?.task ?? null
}

export async function listTasks(filters: {
  projectId: number
  campaignId?: number | undefined
  attackId?: number | undefined
  agentId?: number | undefined
  status?: string | undefined
  limit?: number | undefined
  offset?: number | undefined
}) {
  // Project scope is enforced at the service boundary via INNER JOIN
  // on campaigns. Every caller MUST pass projectId; we deliberately
  // do not expose an unscoped overload.
  const conditions = [eq(campaigns.projectId, filters.projectId)]
  if (filters.campaignId) {
    conditions.push(eq(tasks.campaignId, filters.campaignId))
  }
  if (filters.attackId) {
    conditions.push(eq(tasks.attackId, filters.attackId))
  }
  if (filters.agentId) {
    conditions.push(eq(tasks.agentId, filters.agentId))
  }
  if (filters.status) {
    conditions.push(eq(tasks.status, filters.status))
  }

  const limit = filters.limit ?? 50
  const offset = filters.offset ?? 0

  const whereClause = and(...conditions)

  const [results, countResult] = await Promise.all([
    db
      .select({ task: tasks })
      .from(tasks)
      .innerJoin(campaigns, eq(tasks.campaignId, campaigns.id))
      .where(whereClause)
      .limit(limit)
      .offset(offset)
      .orderBy(desc(tasks.createdAt)),
    db
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .innerJoin(campaigns, eq(tasks.campaignId, campaigns.id))
      .where(whereClause),
  ])

  return {
    tasks: results.map((r) => r.task),
    total: Number(countResult[0]?.count ?? 0),
    limit,
    offset,
  }
}

// ─── Re-exports from ./tasks/* submodules ────────────────────────────
//
// Several concerns live in their own files so this parent stays under
// the per-file size budget. Re-exporting here is the contract — every
// caller (including the lazy `await import('../tasks.js')` in
// `services/agents/heartbeat.ts`, the seven `mock.module(...)` test
// registrations against this path, and the workers + route handlers)
// resolves through `services/tasks.js` exactly as it did before the
// split. Keep this list complete; a missing symbol degrades the lazy
// import silently.
export {
  AGENT_TASK_ACTIVE_STATUSES,
  type AgentTaskActiveStatus,
  listTasksByAgent,
  projectAgentTaskRows,
} from './tasks/agent-projection.js'
export { handleTaskFailure, MAX_RETRIES, reassignStaleTasks } from './tasks/retry.js'
export { getZapsForTask } from './tasks/zaps.js'
