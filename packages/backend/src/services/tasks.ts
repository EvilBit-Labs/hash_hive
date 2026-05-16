import type { AgentTaskSummary, AssignedTask } from '@hashhive/shared';
import {
  agentBenchmarks,
  agents,
  attacks,
  campaigns,
  hashItems,
  maskLists,
  ruleLists,
  tasks,
  wordLists,
} from '@hashhive/shared';
import { and, desc, eq, gt, inArray, isNotNull, type SQL, sql } from 'drizzle-orm';
import { logger } from '../config/logger.js';
import { db } from '../db/index.js';
import { getAgentBenchmarkForMode } from './agents.js';
import { updateCampaignProgress } from './campaigns.js';
import { pickChunkSize } from './chunk-sizing.js';
import { emitCrackResult, emitTaskUpdate } from './events.js';
import { calculateAttackKeyspace } from './keyspace.js';

// ─── Task Generation ────────────────────────────────────────────────

// Below this threshold, workRange fields can be stored as JS Number safely
// without losing precision (Number.MAX_SAFE_INTEGER = 2^53 - 1).
const SAFE_NUMBER_THRESHOLD = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Pick the JSON representation of a bigint value: a JS Number when the value
 * fits in JS-safe integer range, otherwise a decimal string. Keeps existing
 * `tasks.workRange` consumers (which read fields as numbers) working for
 * realistic-sized attacks while preserving precision for mask keyspaces that
 * overflow Number.MAX_SAFE_INTEGER.
 */
function jsonSafeBigint(value: bigint): number | string {
  return value <= SAFE_NUMBER_THRESHOLD ? Number(value) : value.toString();
}

/**
 * Derives required capabilities from an attack's configuration.
 * Used when generating tasks so agents can be matched by capability.
 */
function deriveRequiredCapabilities(attack: {
  mode: number;
  advancedConfiguration: unknown;
}): Record<string, unknown> {
  const caps: Record<string, unknown> = {};
  const config = (attack.advancedConfiguration ?? {}) as Record<string, unknown>;

  // Attacks requiring GPU acceleration
  if (config['useGpu'] === true) {
    caps['gpu'] = true;
  }

  // Store the hashcat mode so agents can advertise supported modes
  caps['hashcatMode'] = attack.mode;

  return caps;
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
    );
}

/**
 * Resolve the keyspace inputs for an attack by joining its wordlist /
 * rulelist / masklist references and reading the mask string from
 * `advancedConfiguration.mask` when present.
 *
 * Mode 1 (combination) currently has no schema field for a second
 * wordlist, so secondaryWordlistRows stays undefined and combination
 * attacks fall through to the single-task path until that field exists.
 */
async function loadKeyspaceInputs(attack: {
  mode: number;
  wordlistId: number | null;
  rulelistId: number | null;
  masklistId: number | null;
  advancedConfiguration: unknown;
}): Promise<{
  mode: number;
  wordlistRows?: number;
  rulelistRows?: number;
  secondaryWordlistRows?: number;
  mask?: string;
}> {
  const inputs: {
    mode: number;
    wordlistRows?: number;
    rulelistRows?: number;
    secondaryWordlistRows?: number;
    mask?: string;
  } = { mode: attack.mode };

  if (attack.wordlistId !== null) {
    const [row] = await db
      .select({ lineCount: wordLists.lineCount })
      .from(wordLists)
      .where(eq(wordLists.id, attack.wordlistId))
      .limit(1);
    if (row?.lineCount !== null && row?.lineCount !== undefined)
      inputs.wordlistRows = row.lineCount;
  }
  if (attack.rulelistId !== null) {
    const [row] = await db
      .select({ lineCount: ruleLists.lineCount })
      .from(ruleLists)
      .where(eq(ruleLists.id, attack.rulelistId))
      .limit(1);
    if (row?.lineCount !== null && row?.lineCount !== undefined)
      inputs.rulelistRows = row.lineCount;
  }
  if (attack.masklistId !== null) {
    // Masklist line count isn't the same as a mask string keyspace - a
    // masklist file contains one mask per line. Skipping for now; mode 3
    // attacks should set `advancedConfiguration.mask` directly.
    const [row] = await db
      .select({ id: maskLists.id })
      .from(maskLists)
      .where(eq(maskLists.id, attack.masklistId))
      .limit(1);
    if (row) {
      // No mask string here yet - masklist parsing is a follow-up.
    }
  }
  if (attack.advancedConfiguration && typeof attack.advancedConfiguration === 'object') {
    const cfg = attack.advancedConfiguration as Record<string, unknown>;
    if (typeof cfg['mask'] === 'string') inputs.mask = cfg['mask'];
  }
  return inputs;
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
  const [attack] = await db.select().from(attacks).where(eq(attacks.id, attackId)).limit(1);
  if (!attack) {
    return { error: 'Attack not found' };
  }

  const requiredCapabilities = deriveRequiredCapabilities(attack);

  // Resolve total keyspace: prefer the stored value; compute when missing.
  let totalKeyspaceStr = attack.keyspace?.trim() ?? '';
  if (!totalKeyspaceStr || totalKeyspaceStr === '0') {
    const inputs = await loadKeyspaceInputs(attack);
    const computed = calculateAttackKeyspace(inputs);
    totalKeyspaceStr = computed ?? '';
  }

  const totalKeyspace = totalKeyspaceStr ? BigInt(totalKeyspaceStr) : 0n;
  if (totalKeyspace <= 0n) {
    // No keyspace available - emit a single placeholder task so downstream
    // assignment / progress / failure paths still have a row to operate on.
    const [task] = await db
      .insert(tasks)
      .values({
        attackId: attack.id,
        campaignId: attack.campaignId,
        status: 'pending',
        workRange: { start: 0, end: 0, total: 0 },
        requiredCapabilities,
      })
      .returning();

    return { tasks: [task], count: 1 };
  }

  // Decide chunk size - caller override beats fleet-aware sizing for tests.
  let chunkSize: bigint;
  if (opts.chunkSize !== undefined) {
    chunkSize = BigInt(opts.chunkSize);
  } else {
    const benchmarks = await getFleetBenchmarksForMode(attack.projectId, attack.mode);
    chunkSize = BigInt(pickChunkSize({ totalKeyspace: totalKeyspaceStr, benchmarks }));
  }

  // Cap chunk count to bound memory + DB-row inserts. A `?a^12` mask attack
  // (~5.4e23 keyspace) at MAX_CHUNK_SIZE (1e9) would otherwise materialize
  // ~5.4e14 task rows and OOM the process. When the floor lifts chunkSize
  // past MAX_CHUNK_SIZE, the caller-visible truncation is the only way to
  // keep generation finite - the trailing remainder becomes a single
  // oversized task that the heartbeat-monitor rebalance branch will split
  // further as agents make progress against it.
  const MAX_CHUNKS_PER_ATTACK = 100_000n;
  if (totalKeyspace / chunkSize > MAX_CHUNKS_PER_ATTACK) {
    chunkSize = totalKeyspace / MAX_CHUNKS_PER_ATTACK;
    if (totalKeyspace % MAX_CHUNKS_PER_ATTACK !== 0n) chunkSize += 1n;
  }

  const chunks: Array<{
    start: number | string;
    end: number | string;
    total: number | string;
  }> = [];
  for (let start = 0n; start < totalKeyspace; start += chunkSize) {
    const end = start + chunkSize > totalKeyspace ? totalKeyspace : start + chunkSize;
    chunks.push({
      start: jsonSafeBigint(start),
      end: jsonSafeBigint(end),
      total: jsonSafeBigint(end - start),
    });
  }

  const createdTasks = await db
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
    .returning();

  return { tasks: createdTasks, count: createdTasks.length };
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
function buildCapabilityPredicate(agentCaps: Record<string, unknown>): SQL {
  const hasGpu = agentCaps['gpu'] === true;
  const rawHashModes = Array.isArray(agentCaps['hashModes']) ? agentCaps['hashModes'] : [];
  // Sanitize to finite integers only — NaN, Infinity, non-numeric strings are dropped
  const hashModes = rawHashModes
    .map((m: unknown) => Number(m))
    .filter((n): n is number => Number.isFinite(n) && Number.isInteger(n));

  // GPU check: if the task requires GPU, the agent must have it.
  // If the agent has GPU, this is always satisfied. If not, exclude GPU-requiring tasks.
  const gpuCondition = hasGpu
    ? sql`TRUE`
    : sql`NOT (${tasks.requiredCapabilities}->>'gpu' = 'true')`;

  // Hash mode check: the task's required hashcatMode must be in the agent's hashModes array.
  // If agent advertises no hashModes (or all were invalid), only tasks without a hashcatMode requirement pass.
  const hashModeCondition =
    hashModes.length > 0
      ? sql`(
          ${tasks.requiredCapabilities}->>'hashcatMode' IS NULL
          OR (${tasks.requiredCapabilities}->>'hashcatMode')::int = ANY(${hashModes}::int[])
        )`
      : sql`(${tasks.requiredCapabilities}->>'hashcatMode' IS NULL)`;

  return sql`(${gpuCondition} AND ${hashModeCondition})`;
}

const DEFAULT_AGENT_SPEED_HS = 1_000_000; // 1 MH/s fallback when no benchmark exists

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
    );
  if (!pendingTotal || pendingTotal.n === 0) {
    return 'no_pending_tasks';
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
    );
  if (!matching || matching.n === 0) {
    return 'no_matching_capability';
  }

  // Matching candidates exist but the CTE returned zero rows - every
  // candidate must have been locked by a concurrent claimant.
  return 'claim_race_lost';
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
  | 'claim_race_lost'; // candidate locked by another claimant via SKIP LOCKED

function logAssignmentSkip(
  agentId: number,
  projectId: number | null,
  reason: AssignmentSkipReason
): void {
  logger.info(
    { event: 'task_assignment', kind: 'skipped', agentId, projectId, reason },
    'task assignment skipped'
  );
}

function logAssignmentSuccess(agentId: number, projectId: number, taskId: number): void {
  logger.info(
    { event: 'task_assignment', kind: 'assigned', agentId, projectId, taskId },
    'task assigned'
  );
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
export async function assignNextTask(agentId: number): Promise<AssignedTask | null> {
  // Verify agent exists and is online or benchmarked
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!agent || (agent.status !== 'online' && agent.status !== 'benchmarked')) {
    logAssignmentSkip(agentId, agent?.projectId ?? null, 'agent_not_eligible');
    return null;
  }

  const projectId = agent.projectId;
  const agentCaps = (agent.capabilities ?? {}) as Record<string, unknown>;
  const capabilityPredicate = buildCapabilityPredicate(agentCaps);

  // Atomic candidate selection + claim via raw SQL with FOR UPDATE SKIP LOCKED
  const result = await db.execute(sql`
    WITH candidate AS (
      SELECT ${tasks.id} AS task_id
      FROM ${tasks}
      INNER JOIN ${campaigns} ON ${tasks.campaignId} = ${campaigns.id}
      WHERE ${tasks.status} = 'pending'
        AND ${tasks.agentId} IS NULL
        AND ${campaigns.projectId} = ${projectId}
        AND ${capabilityPredicate}
      ORDER BY ${campaigns.priority}, ${tasks.id}
      LIMIT 1
      FOR UPDATE OF ${tasks} SKIP LOCKED
    )
    UPDATE ${tasks}
    SET
      agent_id = ${agentId},
      status = 'assigned',
      assigned_at = NOW(),
      updated_at = NOW()
    FROM candidate
    WHERE ${tasks.id} = candidate.task_id
    RETURNING ${tasks.id}, ${tasks.attackId}, ${tasks.campaignId}, ${tasks.agentId},
              ${tasks.status}, ${tasks.workRange}, ${tasks.progress}, ${tasks.resultStats},
              ${tasks.requiredCapabilities}, ${tasks.assignedAt}, ${tasks.startedAt},
              ${tasks.completedAt}, ${tasks.failureReason}, ${tasks.createdAt}, ${tasks.updatedAt}
  `);

  const row = result[0] as Record<string, unknown> | undefined;
  if (!row) {
    // Distinguish "nothing pending in this project" from "pending exists
    // but none match this agent" from "candidate locked by a peer". The
    // additional queries are cheap (one index hit per skip event) and
    // give operators the signal they need to debug fleet utilization.
    //
    // Best-effort: if the diagnostic itself errors (e.g. a transient DB
    // issue), still emit a skip log with a generic reason rather than
    // turning the diagnostic into a new failure mode.
    let reason: AssignmentSkipReason = 'claim_race_lost';
    try {
      reason = await diagnoseAssignmentSkip(projectId, capabilityPredicate);
    } catch (err: unknown) {
      logger.warn(
        { err, agentId, projectId },
        'assignment skip diagnosis failed; logging claim_race_lost as best guess'
      );
    }
    logAssignmentSkip(agentId, projectId, reason);
    return null;
  }
  logAssignmentSuccess(agentId, projectId, row['id'] as number);

  // Extract hashcatMode from the task's required capabilities for benchmark lookup
  // Accept both numeric and numeric-string values (legacy/external inserts may store as string)
  const requiredCaps = row['required_capabilities'] as Record<string, unknown> | null;
  const rawHashcatMode = requiredCaps?.['hashcatMode'];
  const parsedMode =
    typeof rawHashcatMode === 'number'
      ? rawHashcatMode
      : typeof rawHashcatMode === 'string'
        ? Number(rawHashcatMode)
        : Number.NaN;
  const taskHashcatMode =
    Number.isFinite(parsedMode) && Number.isInteger(parsedMode) ? parsedMode : null;

  // Look up the agent's benchmark speed for this hash mode.
  // Wrapped in try-catch because the task is already claimed via FOR UPDATE SKIP LOCKED -
  // a benchmark lookup failure must not orphan the assigned task.
  let agentSpeedHs = DEFAULT_AGENT_SPEED_HS;
  if (taskHashcatMode !== null) {
    try {
      const benchmark = await getAgentBenchmarkForMode(agentId, taskHashcatMode);
      if (benchmark) {
        agentSpeedHs = benchmark.speedHs;
      }
    } catch (err: unknown) {
      logger.warn(
        { err, agentId, hashcatMode: taskHashcatMode },
        'Benchmark lookup failed after task assignment - using default speed'
      );
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
      ...((row['work_range'] as {
        start: number | string;
        end: number | string;
        total: number | string;
      } | null) ?? {
        start: 0,
        end: 0,
        total: 0,
      }),
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
    createdAt: row['created_at'] as Date,
    updatedAt: row['updated_at'] as Date,
  };
}

// ─── Task Progress & Results ────────────────────────────────────────

export async function updateTaskProgress(
  taskId: number,
  agentId: number,
  data: {
    status: string;
    progress?:
      | {
          keyspaceProgress?: number | undefined;
          speed?: number | undefined;
          temperature?: number | undefined;
        }
      | undefined;
    results?: Array<{ hashValue: string; plaintext: string }> | undefined;
  }
) {
  // Single JOIN: verify task ownership and resolve campaign context in one query
  const [taskRow] = await db
    .select({
      taskId: tasks.id,
      attackId: tasks.attackId,
      campaignId: tasks.campaignId,
      startedAt: tasks.startedAt,
      projectId: campaigns.projectId,
      hashListId: campaigns.hashListId,
    })
    .from(tasks)
    .innerJoin(campaigns, eq(tasks.campaignId, campaigns.id))
    .where(and(eq(tasks.id, taskId), eq(tasks.agentId, agentId)))
    .limit(1);

  if (!taskRow) {
    return { error: 'Task not found or not assigned to this agent' };
  }

  const updates: Record<string, unknown> = {
    status: data.status,
    updatedAt: new Date(),
  };

  if (data.progress) {
    updates['progress'] = data.progress;
  }

  if (data.status === 'running' && !taskRow.startedAt) {
    updates['startedAt'] = new Date();
  }

  if (data.status === 'completed' || data.status === 'exhausted') {
    updates['completedAt'] = new Date();
  }

  // Update task status — re-verify ownership in the write path (TOCTOU defense)
  const [updated] = await db
    .update(tasks)
    .set(updates)
    .where(and(eq(tasks.id, taskId), eq(tasks.agentId, agentId)))
    .returning();

  if (!updated) {
    return { error: 'Task was reassigned during update' };
  }

  // Insert cracked hash results if submitted
  if (data.results && data.results.length > 0 && !taskRow.hashListId) {
    logger.error(
      { taskId, campaignId: taskRow.campaignId, resultCount: data.results.length },
      'Cannot store crack results: campaign has no associated hash list'
    );
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
        });

      emitCrackResult(taskRow.projectId, taskRow.hashListId, data.results.length);
    } catch (err) {
      logger.error(
        { err, taskId, agentId, hashListId: taskRow.hashListId, resultCount: data.results.length },
        'Failed to insert crack results'
      );
      return { error: 'Failed to store crack results' };
    }
  }

  // Emit events and update campaign progress (no duplicate campaign fetch)
  emitTaskUpdate(taskRow.projectId, taskId, data.status, {
    agentId,
    progress: data.progress,
  });
  await updateCampaignProgress(taskRow.campaignId);

  return { task: updated };
}

// ─── Task Retry & Failure Handling ──────────────────────────────────

const MAX_RETRIES = 3;

export async function handleTaskFailure(taskId: number, agentId: number, reason: string) {
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.agentId, agentId)))
    .limit(1);
  if (!task) {
    return { error: 'Task not found or not assigned to this agent' };
  }

  const resultStats = (task.resultStats as Record<string, unknown>) ?? {};
  const retryCount = (resultStats['retryCount'] as number) ?? 0;

  // Derive projectId from the campaign for event emission
  const [campaign] = await db
    .select({ projectId: campaigns.projectId })
    .from(campaigns)
    .where(eq(campaigns.id, task.campaignId))
    .limit(1);

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
        resultStats: { ...resultStats, retryCount: retryCount + 1, lastFailure: reason },
        updatedAt: new Date(),
      })
      .where(and(eq(tasks.id, taskId), eq(tasks.agentId, agentId)))
      .returning();

    if (updated && campaign) {
      // Surface the agent that was just freed so listeners can refresh that
      // agent's caches; the row itself no longer holds agentId after retry.
      emitTaskUpdate(campaign.projectId, taskId, 'pending', { agentId });
    }

    return { task: updated, retried: true };
  }

  // Max retries exceeded — mark as failed permanently
  const [updated] = await db
    .update(tasks)
    .set({
      status: 'failed',
      failureReason: reason,
      completedAt: new Date(),
      resultStats: { ...resultStats, retryCount, lastFailure: reason },
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, taskId))
    .returning();

  if (updated && campaign) {
    emitTaskUpdate(campaign.projectId, taskId, 'failed', { agentId });
  }

  return { task: updated, retried: false };
}

/**
 * Read the keyspace-progress value from a task's `progress` jsonb. Accepts
 * either a number or a numeric string (older agents may emit either).
 * Returns 0 for missing / unparseable values so the caller can treat the
 * task as "fresh" rather than fail noisily.
 */
function readKeyspaceProgress(progress: unknown): bigint {
  if (progress === null || typeof progress !== 'object') return 0n;
  const raw = (progress as Record<string, unknown>)['keyspaceProgress'];
  if (typeof raw === 'number' && Number.isFinite(raw)) return BigInt(Math.floor(raw));
  if (typeof raw === 'string') {
    try {
      return BigInt(raw);
    } catch {
      return 0n;
    }
  }
  return 0n;
}

/**
 * Read a numeric field from a task's `work_range` jsonb. Accepts either a
 * JS Number (used for in-safe-range chunks) or a decimal string (used for
 * mask-attack chunks beyond Number.MAX_SAFE_INTEGER).
 */
function readWorkRangeField(workRange: unknown, key: string): bigint {
  if (workRange === null || typeof workRange !== 'object') return 0n;
  const raw = (workRange as Record<string, unknown>)[key];
  if (typeof raw === 'number' && Number.isFinite(raw)) return BigInt(Math.floor(raw));
  if (typeof raw === 'string') {
    try {
      return BigInt(raw);
    } catch {
      return 0n;
    }
  }
  return 0n;
}

/**
 * Reassigns tasks from agents that have gone offline. Called periodically
 * by a background job (every 2 minutes via BullMQ).
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
 */
export async function reassignStaleTasks(staleThresholdMs = 5 * 60 * 1000) {
  const threshold = new Date(Date.now() - staleThresholdMs);

  // Find tasks assigned to agents that haven't checked in. Carry workRange,
  // progress, and the campaign's projectId so the rebalance branches don't
  // need extra queries to publish task_update events.
  const staleTasks = await db
    .select({
      taskId: tasks.id,
      agentId: tasks.agentId,
      workRange: tasks.workRange,
      progress: tasks.progress,
      projectId: campaigns.projectId,
    })
    .from(tasks)
    .innerJoin(agents, eq(tasks.agentId, agents.id))
    .innerJoin(campaigns, eq(tasks.campaignId, campaigns.id))
    .where(and(eq(tasks.status, 'assigned'), sql`${agents.lastSeenAt} < ${threshold}`));

  let reassigned = 0;
  let rebalanced = 0;
  let failedOverrun = 0;
  for (const staleTask of staleTasks) {
    const start = readWorkRangeField(staleTask.workRange, 'start');
    const end = readWorkRangeField(staleTask.workRange, 'end');
    const total = end > start ? end - start : 0n;
    const keyspaceProgress = readKeyspaceProgress(staleTask.progress);

    if (keyspaceProgress >= total && total > 0n) {
      // Agent reported as-much-or-more work than the chunk contains. Either
      // the agent finished the entire range but died before sending the
      // completion message, or its report is malformed. Either way, the
      // chunk did not flow through the normal completion path - mark
      // failed so a fresh agent reruns the range rather than silently
      // trusting an un-acked completion.
      // Don't requeue - mark failed and let the campaign aggregate handle it.
      await db
        .update(tasks)
        .set({
          status: 'failed',
          failureReason: 'keyspace_progress_overrun',
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, staleTask.taskId));
      emitTaskUpdate(staleTask.projectId, staleTask.taskId, 'failed');
      failedOverrun++;
      continue;
    }

    if (keyspaceProgress > 0n && keyspaceProgress < total) {
      // Partial progress - trim workRange.start forward and re-pend.
      const newStart = start + keyspaceProgress;
      const newTotal = end - newStart;
      await db
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
          // Reset reported progress so the next agent starts from 0 within
          // the trimmed range. Preserve other progress fields (e.g. speed
          // samples) if a future schema adds them.
          progress: {},
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, staleTask.taskId));
      emitTaskUpdate(staleTask.projectId, staleTask.taskId, 'pending');
      rebalanced++;
      continue;
    }

    // 0% progress or unreadable range - reset to pending unchanged.
    await db
      .update(tasks)
      .set({
        status: 'pending',
        agentId: null,
        assignedAt: null,
        startedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, staleTask.taskId));
    emitTaskUpdate(staleTask.projectId, staleTask.taskId, 'pending');
    reassigned++;
  }

  return { reassigned, rebalanced, failedOverrun };
}

// ─── Task Queries ───────────────────────────────────────────────────

export async function getTaskById(id: number) {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
  return task ?? null;
}

export async function listTasks(filters: {
  campaignId?: number | undefined;
  attackId?: number | undefined;
  agentId?: number | undefined;
  status?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}) {
  let query = db.select().from(tasks).$dynamic();

  const conditions = [];
  if (filters.campaignId) {
    conditions.push(eq(tasks.campaignId, filters.campaignId));
  }
  if (filters.attackId) {
    conditions.push(eq(tasks.attackId, filters.attackId));
  }
  if (filters.agentId) {
    conditions.push(eq(tasks.agentId, filters.agentId));
  }
  if (filters.status) {
    conditions.push(eq(tasks.status, filters.status));
  }
  if (conditions.length > 0) {
    query = query.where(and(...conditions));
  }

  const limit = filters.limit ?? 50;
  const offset = filters.offset ?? 0;

  const [results, countResult] = await Promise.all([
    query.limit(limit).offset(offset).orderBy(desc(tasks.createdAt)),
    db
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .where(conditions.length > 0 ? and(...conditions) : undefined),
  ]);

  return {
    tasks: results,
    total: Number(countResult[0]?.count ?? 0),
    limit,
    offset,
  };
}

// ─── Zap Endpoint (cracked hashes for a task) ───────────────────────

/**
 * Returns cracked hash values for a given task, scoped to the agent's project.
 * Used by agents to retrieve "zaps" — hashes cracked by any campaign sharing
 * the same hash list, so agents can skip already-cracked hashes.
 */
export async function getZapsForTask(
  taskId: number,
  agentId: number,
  projectId: number,
  opts: { since?: Date | undefined; limit?: number | undefined } = {}
): Promise<{ zaps: string[]; hasMore: boolean } | { error: string }> {
  const fetchLimit = opts.limit ?? 10_000;

  // Single JOIN: tasks -> campaigns to get hashListId + verify ownership + project scope
  const [taskRow] = await db
    .select({
      taskId: tasks.id,
      hashListId: campaigns.hashListId,
    })
    .from(tasks)
    .innerJoin(campaigns, eq(tasks.campaignId, campaigns.id))
    .where(
      and(eq(tasks.id, taskId), eq(tasks.agentId, agentId), eq(campaigns.projectId, projectId))
    )
    .limit(1);

  if (!taskRow) {
    return { error: 'Task not found or not assigned to this agent' };
  }

  if (!taskRow.hashListId) {
    return { zaps: [], hasMore: false };
  }

  // Build conditions for cracked hash items
  const conditions = [eq(hashItems.hashListId, taskRow.hashListId), isNotNull(hashItems.crackedAt)];

  if (opts.since) {
    conditions.push(gt(hashItems.crackedAt, opts.since));
  }

  // Fetch limit+1 to detect hasMore
  const rows = await db
    .select({ hashValue: hashItems.hashValue })
    .from(hashItems)
    .where(and(...conditions))
    .orderBy(hashItems.crackedAt)
    .limit(fetchLimit + 1);

  const hasMore = rows.length > fetchLimit;
  const zaps = (hasMore ? rows.slice(0, fetchLimit) : rows).map((r) => r.hashValue);

  return { zaps, hasMore };
}

// ─── Per-Agent Task Listing ─────────────────────────────────────────

export const AGENT_TASK_ACTIVE_STATUSES = ['pending', 'assigned', 'running'] as const;
export type AgentTaskActiveStatus = (typeof AGENT_TASK_ACTIVE_STATUSES)[number];

/**
 * Test-only: convert a raw join-row shape (same fields the SQL selects)
 * into the wire-shape AgentTaskSummary[]. Exported so the projection
 * logic — Date→ISO conversion, progress fallback, status preservation —
 * can be unit-tested without a database.
 */
export function projectAgentTaskRows(
  rows: ReadonlyArray<{
    id: number;
    campaignId: number;
    campaignName: string;
    attackId: number;
    attackMode: number;
    status: string;
    progress: unknown;
    startedAt: Date | string | null;
    assignedAt: Date | string | null;
  }>
): AgentTaskSummary[] {
  const iso = (v: Date | string | null): string | null => {
    if (v === null) return null;
    if (v instanceof Date) return v.toISOString();
    return v;
  };
  return rows.map((row) => ({
    id: row.id,
    campaignId: row.campaignId,
    campaignName: row.campaignName,
    attackId: row.attackId,
    attackMode: row.attackMode,
    status: row.status,
    progress: (row.progress as Record<string, unknown> | null) ?? {},
    startedAt: iso(row.startedAt),
    assignedAt: iso(row.assignedAt),
  }));
}

/**
 * Returns active tasks assigned to an agent (pending, assigned, running),
 * joined with campaign and attack names for display in the agent detail UI.
 *
 * Project scoping is the caller's responsibility — verify the agent belongs
 * to the caller's project before invoking.
 */
export async function listTasksByAgent(agentId: number): Promise<AgentTaskSummary[]> {
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
    .where(and(eq(tasks.agentId, agentId), inArray(tasks.status, [...AGENT_TASK_ACTIVE_STATUSES])))
    .orderBy(desc(tasks.startedAt), desc(tasks.assignedAt));

  return projectAgentTaskRows(rows);
}
