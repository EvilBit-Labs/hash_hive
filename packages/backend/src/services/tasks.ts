import { agents, attacks, campaigns, hashItems, tasks } from '@hashhive/shared';
import { and, desc, eq, gt, isNotNull, type SQL, sql } from 'drizzle-orm';
import { logger } from '../config/logger.js';
import { db } from '../db/index.js';
import { updateCampaignProgress } from './campaigns.js';
import { emitCrackResult, emitTaskUpdate } from './events.js';

// ─── Task Generation ────────────────────────────────────────────────

const DEFAULT_CHUNK_SIZE = 10_000_000; // 10M keyspace units per task

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
 * Generates tasks for an attack by partitioning its keyspace into chunks.
 * Each chunk becomes a task that can be assigned to an agent.
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
  const totalKeyspace = Number.parseInt(attack.keyspace ?? '0', 10);
  if (totalKeyspace <= 0) {
    // For attacks without a pre-calculated keyspace, create a single task
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

  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const chunks: Array<{ start: number; end: number; total: number }> = [];

  for (let start = 0; start < totalKeyspace; start += chunkSize) {
    const end = Math.min(start + chunkSize, totalKeyspace);
    chunks.push({ start, end, total: end - start });
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

/**
 * Assigns the next available pending task to an agent.
 *
 * All eligibility filters (project scope, capability match) are enforced
 * in the SQL predicate. Uses `FOR UPDATE SKIP LOCKED` to guarantee only
 * one claimant atomically selects and claims a task row, even under
 * concurrent access from multiple agents.
 */
export async function assignNextTask(agentId: number) {
  // Verify agent exists and is online
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!agent || agent.status !== 'online') {
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
  if (!row) return null;

  // Map snake_case DB columns back to camelCase to preserve the public API contract
  return {
    id: row['id'],
    attackId: row['attack_id'],
    campaignId: row['campaign_id'],
    agentId: row['agent_id'],
    status: row['status'],
    workRange: row['work_range'],
    progress: row['progress'],
    resultStats: row['result_stats'],
    requiredCapabilities: row['required_capabilities'],
    assignedAt: row['assigned_at'],
    startedAt: row['started_at'],
    completedAt: row['completed_at'],
    failureReason: row['failure_reason'],
    createdAt: row['created_at'],
    updatedAt: row['updated_at'],
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
  emitTaskUpdate(taskRow.projectId, taskId, data.status, data.progress);
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
      emitTaskUpdate(campaign.projectId, taskId, 'pending');
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
    emitTaskUpdate(campaign.projectId, taskId, 'failed');
  }

  return { task: updated, retried: false };
}

/**
 * Reassigns tasks from agents that have gone offline.
 * Called periodically by a background job.
 */
export async function reassignStaleTasks(staleThresholdMs = 5 * 60 * 1000) {
  const threshold = new Date(Date.now() - staleThresholdMs);

  // Find tasks assigned to agents that haven't checked in
  const staleTasks = await db
    .select({ taskId: tasks.id, agentId: tasks.agentId })
    .from(tasks)
    .innerJoin(agents, eq(tasks.agentId, agents.id))
    .where(and(eq(tasks.status, 'assigned'), sql`${agents.lastSeenAt} < ${threshold}`));

  let reassigned = 0;
  for (const staleTask of staleTasks) {
    await db
      .update(tasks)
      .set({
        status: 'pending',
        agentId: null,
        assignedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, staleTask.taskId));
    reassigned++;
  }

  return { reassigned };
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
