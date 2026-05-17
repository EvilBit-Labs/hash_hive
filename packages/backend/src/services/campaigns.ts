import { agents, attacks, campaigns, tasks } from '@hashhive/shared';
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { MIN_CHUNK_SIZE } from './chunk-sizing.js';
import { emitCampaignStatus } from './events.js';
import { getHashListStats } from './resources.js';

// Threshold: inline generation when estimated tasks < 100, async enqueue when >= 100
export const INLINE_GENERATION_THRESHOLD = 100;
// Use the smallest possible runtime chunk size as the estimator's basis so
// the chunk-count estimate is an upper bound on what generateTasksForAttack
// will actually emit. pickChunkSize can clamp as low as MIN_CHUNK_SIZE for
// slow fleets, so using the legacy 10M constant would let attacks slip
// through the inline gate and then materialize 4 orders of magnitude more
// rows in the request path.
const CHUNK_SIZE = Number(MIN_CHUNK_SIZE);

// Dynamic import getters — break circular dependency (campaigns ↔ tasks) while
// remaining testable. bun:test's mock.module cannot override already-cached
// dynamic imports across test files, so tests swap these getters instead.
export const _deps = {
  getTasksModule: () => import('./tasks.js'),
  getQueueContext: () => import('../queue/context.js'),
  getQueueConfig: () => import('../config/queue.js'),
  getQueueTypes: () => import('../queue/types.js'),
};

/**
 * Decide whether an attack with a null `keyspace` is *computable* by
 * `generateTasksForAttack` at generation time. The keyspace calculator
 * needs mode-specific inputs:
 *   - mode 0 (straight): wordlist (rules optional)
 *   - mode 1 (combination): two wordlists — schema only has one, so
 *     this mode is never auto-computable today
 *   - mode 3 (mask): a mask string in advancedConfiguration
 *   - modes 6 / 7 (hybrid): wordlist + mask
 *
 * When the inputs are present, the computed keyspace may dwarf the
 * stored "1 task" estimate (e.g., `?a^12` ~ 5.4e23, lifted by
 * `MAX_CHUNKS_PER_ATTACK = 100_000` chunks). Routing such attacks to
 * async generation keeps the request path from blocking on 100k+
 * inline INSERTs.
 */
function isAttackKeyspaceComputable(atk: {
  mode?: number | null | undefined;
  wordlistId?: number | null | undefined;
  masklistId?: number | null | undefined;
  advancedConfiguration?: unknown;
}): boolean {
  if (atk.mode === undefined || atk.mode === null) return false;
  const mask =
    atk.advancedConfiguration &&
    typeof atk.advancedConfiguration === 'object' &&
    typeof (atk.advancedConfiguration as Record<string, unknown>)['mask'] === 'string'
      ? ((atk.advancedConfiguration as Record<string, unknown>)['mask'] as string)
      : null;
  switch (atk.mode) {
    case 0:
      return atk.wordlistId != null;
    case 3:
      return mask !== null && mask.length > 0;
    case 6:
    case 7:
      return atk.wordlistId != null && mask !== null && mask.length > 0;
    default:
      return false;
  }
}

/**
 * Estimates total task count and returns the generation strategy.
 * Exported for direct unit testing of the threshold boundary.
 *
 * Keyspaces are parsed via BigInt so mask-attack values past
 * `Number.MAX_SAFE_INTEGER` (e.g., `?a^12` is ~5.4e23) don't lose
 * precision before the chunk-count division.
 *
 * Null/empty keyspaces are routed by `isAttackKeyspaceComputable`:
 * computable attacks force async (they may generate up to
 * MAX_CHUNKS_PER_ATTACK chunks at run time), and the legacy "treat
 * as 1 task" behavior is preserved only for attacks where the
 * calculator would also fall through to a single-placeholder task.
 */
export function resolveGenerationStrategy(
  attackList: ReadonlyArray<{
    keyspace: string | null;
    mode?: number | null | undefined;
    wordlistId?: number | null | undefined;
    masklistId?: number | null | undefined;
    advancedConfiguration?: unknown;
  }>
): 'inline' | 'async' {
  let estimatedTasks = 0;
  const chunkSize = BigInt(CHUNK_SIZE);
  for (const atk of attackList) {
    const raw = atk.keyspace?.trim();
    if (!raw || raw === '0') {
      // Null / zero / blank keyspace.
      if (isAttackKeyspaceComputable(atk)) {
        // generateTasksForAttack will compute the real keyspace and
        // may generate up to MAX_CHUNKS_PER_ATTACK chunks inline.
        // Force async so the request path doesn't block on the burst.
        return 'async';
      }
      // Calculator will fall through to a single placeholder task.
      estimatedTasks += 1;
      continue;
    }
    let bigKs: bigint;
    try {
      bigKs = BigInt(raw);
    } catch {
      estimatedTasks += 1;
      continue;
    }
    if (bigKs <= 0n) {
      estimatedTasks += 1;
      continue;
    }
    const chunks = bigKs / chunkSize + (bigKs % chunkSize === 0n ? 0n : 1n);
    // Saturate at INLINE_GENERATION_THRESHOLD so the comparison stays
    // within safe-Number range even for astronomical keyspaces.
    estimatedTasks +=
      chunks > BigInt(INLINE_GENERATION_THRESHOLD) ? INLINE_GENERATION_THRESHOLD : Number(chunks);
    if (estimatedTasks >= INLINE_GENERATION_THRESHOLD) return 'async';
  }
  return estimatedTasks < INLINE_GENERATION_THRESHOLD ? 'inline' : 'async';
}

// ─── Campaign CRUD ──────────────────────────────────────────────────

export type CampaignSortField = 'name' | 'createdAt' | 'priority';
export type CampaignSortOrder = 'asc' | 'desc';

const SORT_COLUMNS = {
  name: campaigns.name,
  createdAt: campaigns.createdAt,
  priority: campaigns.priority,
} as const;

export async function listCampaigns(filters: {
  projectId?: number | undefined;
  status?: string | undefined;
  priority?: number | undefined;
  sort?: CampaignSortField | undefined;
  order?: CampaignSortOrder | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}) {
  let query = db.select().from(campaigns).$dynamic();

  const conditions = [];
  if (filters.projectId) {
    conditions.push(eq(campaigns.projectId, filters.projectId));
  }
  if (filters.status) {
    conditions.push(eq(campaigns.status, filters.status));
  }
  if (filters.priority !== undefined) {
    conditions.push(eq(campaigns.priority, filters.priority));
  }
  if (conditions.length > 0) {
    query = query.where(and(...conditions));
  }

  const limit = filters.limit ?? 50;
  const offset = filters.offset ?? 0;

  const sortField = filters.sort ?? 'createdAt';
  const sortOrder = filters.order ?? 'desc';
  const sortColumn = SORT_COLUMNS[sortField];
  const orderClause = sortOrder === 'asc' ? asc(sortColumn) : desc(sortColumn);

  const [results, countResult] = await Promise.all([
    query.limit(limit).offset(offset).orderBy(orderClause),
    db
      .select({ count: sql<number>`count(*)` })
      .from(campaigns)
      .where(conditions.length > 0 ? and(...conditions) : undefined),
  ]);

  return {
    campaigns: results,
    total: Number(countResult[0]?.count ?? 0),
    limit,
    offset,
  };
}

export async function getCampaignById(id: number) {
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
  return campaign ?? null;
}

// ─── Campaign Stats & Active Agents ─────────────────────────────────

export interface CampaignTaskStats {
  total: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
}

/**
 * Aggregate task counts for a campaign, bucketed into the four operator-facing
 * states. The data model emits more nuanced statuses ('assigned', 'exhausted');
 * those are folded into the closest operator bucket:
 *   - assigned + running -> running (both represent active work)
 *   - completed + exhausted -> completed (both represent successful end state)
 *   - pending -> pending
 *   - failed -> failed
 */
export async function getCampaignTaskStats(campaignId: number): Promise<CampaignTaskStats> {
  const rows = await db
    .select({
      status: tasks.status,
      n: sql<number>`count(*)::int`,
    })
    .from(tasks)
    .where(eq(tasks.campaignId, campaignId))
    .groupBy(tasks.status);

  const stats: CampaignTaskStats = {
    total: 0,
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
  };

  for (const row of rows) {
    const n = Number(row.n ?? 0);
    stats.total += n;
    switch (row.status) {
      case 'pending':
        stats.pending += n;
        break;
      case 'assigned':
      case 'running':
        stats.running += n;
        break;
      case 'completed':
      case 'exhausted':
        stats.completed += n;
        break;
      case 'failed':
        stats.failed += n;
        break;
      default:
        // Unknown future status — count toward total only.
        break;
    }
  }

  return stats;
}

export interface CampaignActiveAgent {
  agentId: number;
  agentName: string;
  taskId: number;
  attackId: number;
  attackMode: number;
  progress: unknown;
  speedHs: number | null;
}

const ACTIVE_AGENTS_LIMIT = 50;

/**
 * Active agents working on a campaign right now. Joins tasks that are pending,
 * assigned, or running (the {@link AGENT_TASK_ACTIVE_STATUSES} set) and have a
 * non-null agentId. Speed is extracted from the task's progress jsonb when
 * available; falls back to null so callers can render a placeholder.
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
    .limit(ACTIVE_AGENTS_LIMIT);

  return rows.map((row) => {
    const progress = row.progress as Record<string, unknown> | null;
    const rawSpeed = progress && typeof progress === 'object' ? progress['speedHs'] : null;
    const speedHs = typeof rawSpeed === 'number' && Number.isFinite(rawSpeed) ? rawSpeed : null;
    return {
      agentId: row.agentId,
      agentName: row.agentName,
      taskId: row.taskId,
      attackId: row.attackId,
      attackMode: row.attackMode,
      progress: row.progress,
      speedHs,
    };
  });
}

// ─── Draft-only delete ──────────────────────────────────────────────

export type DeleteCampaignResult =
  | { ok: true; campaign: typeof campaigns.$inferSelect }
  | { error: 'NOT_FOUND' }
  | { error: 'NOT_DRAFT'; status: string };

/**
 * Delete a campaign if and only if its status is 'draft'. Attacks and tasks
 * are removed in the same transaction; FK constraints are not CASCADE in the
 * current schema, so child rows are deleted explicitly.
 */
export async function deleteCampaign(id: number): Promise<DeleteCampaignResult> {
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
    if (!existing) {
      return { error: 'NOT_FOUND' } as const;
    }
    if (existing.status !== 'draft') {
      return { error: 'NOT_DRAFT', status: existing.status } as const;
    }

    // Remove child rows (FKs are RESTRICT by default).
    await tx.delete(tasks).where(eq(tasks.campaignId, id));
    await tx.delete(attacks).where(eq(attacks.campaignId, id));
    const [deleted] = await tx.delete(campaigns).where(eq(campaigns.id, id)).returning();
    if (!deleted) {
      return { error: 'NOT_FOUND' } as const;
    }
    return { ok: true, campaign: deleted } as const;
  });
}

export async function createCampaign(data: {
  projectId: number;
  name: string;
  description?: string | undefined;
  hashListId: number;
  priority?: number | undefined;
  createdBy?: number | undefined;
}) {
  const [campaign] = await db
    .insert(campaigns)
    .values({
      projectId: data.projectId,
      name: data.name,
      description: data.description ?? null,
      hashListId: data.hashListId,
      priority: data.priority ?? 5,
      createdBy: data.createdBy ?? null,
      status: 'draft',
    })
    .returning();

  return campaign ?? null;
}

export async function updateCampaign(
  id: number,
  data: {
    name?: string | undefined;
    description?: string | undefined;
    priority?: number | undefined;
  }
) {
  const [updated] = await db
    .update(campaigns)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(campaigns.id, id))
    .returning();

  return updated ?? null;
}

// ─── Campaign Lifecycle ─────────────────────────────────────────────

type CampaignStatus = 'draft' | 'running' | 'paused' | 'completed' | 'cancelled';

const VALID_TRANSITIONS: Record<string, CampaignStatus[]> = {
  draft: ['running', 'cancelled'],
  running: ['paused', 'completed', 'cancelled', 'draft'],
  paused: ['running', 'cancelled', 'draft'],
  completed: [],
  cancelled: [],
};

export async function transitionCampaign(id: number, targetStatus: CampaignStatus) {
  const campaign = await getCampaignById(id);
  if (!campaign) {
    return { error: 'Campaign not found' };
  }

  const allowed = VALID_TRANSITIONS[campaign.status] ?? [];
  if (!allowed.includes(targetStatus)) {
    return {
      error: `Cannot transition from '${campaign.status}' to '${targetStatus}'`,
    };
  }

  // Validate campaign has attacks and resources before starting
  if (targetStatus === 'running') {
    const campaignAttacks = await listAttacks(id);
    if (campaignAttacks.length === 0) {
      return { error: 'Campaign must have at least one attack before starting' };
    }
  }

  // When starting/resuming a campaign, verify queue availability before transitioning
  if (targetStatus === 'running') {
    const { getQueueManager } = await _deps.getQueueContext();
    const qm = getQueueManager();
    if (!qm) {
      return {
        error: 'Queue unavailable — cannot start campaign',
        code: 'QUEUE_UNAVAILABLE' as const,
      };
    }
    const health = await qm.getHealth();
    if (health.status === 'disconnected') {
      return {
        error: 'Queue unavailable — cannot start campaign',
        code: 'QUEUE_UNAVAILABLE' as const,
      };
    }
  }

  // Stop action: running/paused → draft means cancel running tasks and reset
  if (targetStatus === 'draft' && (campaign.status === 'running' || campaign.status === 'paused')) {
    await db
      .update(tasks)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(
        and(eq(tasks.campaignId, id), sql`${tasks.status} IN ('pending', 'assigned', 'running')`)
      );
  }

  const updates: Record<string, unknown> = {
    status: targetStatus,
    updatedAt: new Date(),
  };

  if (targetStatus === 'running' && !campaign.startedAt) {
    updates['startedAt'] = new Date();
  }
  if (targetStatus === 'completed' || targetStatus === 'cancelled') {
    updates['completedAt'] = new Date();
  }
  // Stop resets timestamps
  if (targetStatus === 'draft') {
    updates['startedAt'] = null;
    updates['completedAt'] = null;
    updates['progress'] = {};
  }

  const [updated] = await db.update(campaigns).set(updates).where(eq(campaigns.id, id)).returning();

  // Emit status for non-running transitions immediately; for 'running',
  // defer until after task generation enqueue succeeds to avoid premature events.
  if (updated && targetStatus !== 'running') {
    emitCampaignStatus(campaign.projectId, id, targetStatus);
  }

  // When starting a campaign, generate tasks — inline if few, queued if many
  if (targetStatus === 'running') {
    const campaignAttacks = await listAttacks(id);
    if (campaignAttacks.length > 0) {
      const strategy = resolveGenerationStrategy(campaignAttacks);

      if (strategy === 'inline') {
        // Generate inline in parallel — small enough to not block the request meaningfully
        try {
          const { generateTasksForAttack } = await _deps.getTasksModule();
          await Promise.all(campaignAttacks.map((atk) => generateTasksForAttack(atk.id)));
        } catch (_err) {
          // Roll back — inline task generation failed
          await db
            .update(campaigns)
            .set({
              status: campaign.status,
              startedAt: campaign.startedAt,
              completedAt: campaign.completedAt,
              progress: campaign.progress ?? {},
              updatedAt: new Date(),
            })
            .where(eq(campaigns.id, id));
          return { error: 'Task generation failed', code: 'TASK_GENERATION_FAILED' as const };
        }
      } else {
        // Enqueue to the dedicated task-generation job queue
        const { getQueueManager } = await _deps.getQueueContext();
        const { QUEUE_NAMES } = await _deps.getQueueConfig();
        const { JOB_PRIORITY } = await _deps.getQueueTypes();
        const qm = getQueueManager();
        if (!qm) {
          // Roll back — queue disappeared between health check and enqueue
          await db
            .update(campaigns)
            .set({
              status: campaign.status,
              startedAt: campaign.startedAt,
              completedAt: campaign.completedAt,
              progress: campaign.progress ?? {},
              updatedAt: new Date(),
            })
            .where(eq(campaigns.id, id));
          return {
            error: 'Queue unavailable — cannot start campaign',
            code: 'QUEUE_UNAVAILABLE' as const,
          };
        }

        const priorityMap: Record<number, number> = {
          1: JOB_PRIORITY.HIGH,
          5: JOB_PRIORITY.NORMAL,
          10: JOB_PRIORITY.LOW,
        };
        const jobPriority = priorityMap[campaign.priority] ?? JOB_PRIORITY.NORMAL;

        const enqueued = await qm.enqueue(QUEUE_NAMES.TASK_GENERATION, {
          campaignId: id,
          projectId: campaign.projectId,
          attackIds: campaignAttacks.map((a) => a.id),
          priority: jobPriority as 1 | 5 | 10,
        });

        if (!enqueued) {
          // Roll back the entire status transition including timestamps/progress
          await db
            .update(campaigns)
            .set({
              status: campaign.status,
              startedAt: campaign.startedAt,
              completedAt: campaign.completedAt,
              progress: campaign.progress ?? {},
              updatedAt: new Date(),
            })
            .where(eq(campaigns.id, id));
          return {
            error: 'Failed to enqueue task generation',
            code: 'QUEUE_UNAVAILABLE' as const,
          };
        }
      }
    }

    // Emit after successful generation/enqueue
    if (updated) {
      emitCampaignStatus(campaign.projectId, id, targetStatus);
    }
  }

  return { campaign: updated ?? null };
}

// ─── Attack Management ──────────────────────────────────────────────

export async function listAttacks(campaignId: number) {
  return db.select().from(attacks).where(eq(attacks.campaignId, campaignId)).orderBy(attacks.id);
}

/**
 * Paginated variant of `listAttacks` for the Control API. Same shape
 * as the other paginated services (`{ items, total }` via `LIMIT/
 * OFFSET` + `count(*)`). Deterministic order by `attacks.id` ascending.
 */
export async function listAttacksPaginated(
  campaignId: number,
  opts: { limit: number; offset: number }
) {
  const whereClause = eq(attacks.campaignId, campaignId);
  const [items, countResult] = await Promise.all([
    db
      .select()
      .from(attacks)
      .where(whereClause)
      .orderBy(asc(attacks.id))
      .limit(opts.limit)
      .offset(opts.offset),
    db.select({ value: count() }).from(attacks).where(whereClause),
  ]);
  return { items, total: Number(countResult[0]?.value ?? 0) };
}

export async function getAttackById(id: number) {
  const [attack] = await db.select().from(attacks).where(eq(attacks.id, id)).limit(1);
  return attack ?? null;
}

export async function createAttack(data: {
  campaignId: number;
  projectId: number;
  mode: number;
  hashTypeId?: number | undefined;
  wordlistId?: number | undefined;
  rulelistId?: number | undefined;
  masklistId?: number | undefined;
  advancedConfiguration?: Record<string, unknown> | undefined;
  dependencies?: number[] | undefined;
}) {
  const [attack] = await db
    .insert(attacks)
    .values({
      campaignId: data.campaignId,
      projectId: data.projectId,
      mode: data.mode,
      hashTypeId: data.hashTypeId ?? null,
      wordlistId: data.wordlistId ?? null,
      rulelistId: data.rulelistId ?? null,
      masklistId: data.masklistId ?? null,
      advancedConfiguration: data.advancedConfiguration ?? {},
      dependencies: data.dependencies ?? [],
      status: 'pending',
    })
    .returning();

  return attack ?? null;
}

export async function updateAttack(
  id: number,
  data: {
    mode?: number | undefined;
    hashTypeId?: number | undefined;
    wordlistId?: number | undefined;
    rulelistId?: number | undefined;
    masklistId?: number | undefined;
    advancedConfiguration?: Record<string, unknown> | undefined;
    dependencies?: number[] | undefined;
  }
) {
  const [updated] = await db
    .update(attacks)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(attacks.id, id))
    .returning();

  return updated ?? null;
}

export async function deleteAttack(id: number) {
  const [deleted] = await db.delete(attacks).where(eq(attacks.id, id)).returning();
  return deleted ?? null;
}

// ─── Campaign Progress ─────────────────────────────────────────────

export async function updateCampaignProgress(campaignId: number) {
  // Single aggregation query: total tasks, completed count, and clamped running progress.
  //
  // `progress.keyspaceProgress` is the agent-reported count of keyspace units
  // already cracked within a task's `workRange.total`. We divide to get a
  // fraction in [0, 1] (LEAST clamps reports that overrun the chunk to 1.0),
  // then SUM the fractions across running tasks for the campaign's running
  // contribution. The earlier `LEAST(keyspaceProgress, 1)` formulation
  // misread the field as already-a-fraction; the spec at
  // docs/issues/96-keyspace-task-distribution-spec.md is the contract.
  const [agg] = await db
    .select({
      totalTasks: sql<number>`count(*)`,
      completedCount: sql<number>`count(*) FILTER (WHERE ${tasks.status} IN ('completed', 'exhausted'))`,
      // CASE WHEN guards the divide-by-zero case explicitly: a placeholder
      // task created without a real keyspace has `workRange.total = 0`, and
      // letting that flow into the division produces NULL, which
      // `LEAST(NULL, 1) = 1` would silently count as a 100%-complete task.
      // Default to 0 progress for any task with total <= 0.
      //
      // Use ::numeric (arbitrary-precision) instead of ::float for the
      // division: mask-attack keyspaces routinely exceed 2^53 - 1, and
      // ::float would round large numerators / denominators to the
      // nearest 64-bit double - a near-complete task could appear as
      // 1.0 long before the agent actually finished. We cast back to
      // double precision at the outermost boundary so the result still
      // fits the `runningProgress: number` JS field.
      runningProgress: sql<number>`(COALESCE(
        SUM(
          CASE
            WHEN COALESCE((${tasks.workRange}->>'total')::numeric, 0) > 0 THEN
              GREATEST(
                0::numeric,
                LEAST(
                  COALESCE((${tasks.progress}->>'keyspaceProgress')::numeric, 0)
                    / (${tasks.workRange}->>'total')::numeric,
                  1::numeric
                )
              )
            ELSE 0::numeric
          END
        ) FILTER (WHERE ${tasks.status} = 'running'),
        0::numeric
      ))::double precision`,
    })
    .from(tasks)
    .where(eq(tasks.campaignId, campaignId));

  const totalTasks = agg?.totalTasks ?? 0;
  if (totalTasks === 0) return;

  const completedCount = agg?.completedCount ?? 0;
  const runningProgress = agg?.runningProgress ?? 0;

  const overallProgress = (completedCount + runningProgress) / totalTasks;

  // Hash-based progress: look up the campaign's hash list and count cracked vs total
  let hashProgress: {
    total: number;
    cracked: number;
    remaining: number;
    percentage: number;
  } | null = null;

  const [campaign] = await db
    .select({ hashListId: campaigns.hashListId })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);

  if (campaign?.hashListId) {
    const stats = await getHashListStats(campaign.hashListId);

    if (stats.total > 0) {
      hashProgress = {
        ...stats,
        percentage: Math.round((stats.cracked / stats.total) * 10000) / 10000,
      };
    }
  }

  await db
    .update(campaigns)
    .set({
      progress: {
        totalTasks,
        completedTasks: completedCount,
        overallProgress: Math.round(overallProgress * 10000) / 10000,
        updatedAt: new Date().toISOString(),
        ...(hashProgress ? { hashProgress } : {}),
      },
      updatedAt: new Date(),
    })
    .where(eq(campaigns.id, campaignId));
}

// ─── DAG Validation ─────────────────────────────────────────────────

/**
 * Validates that the attacks in a campaign form a valid DAG
 * (no circular dependencies). Uses Kahn's algorithm for topological sort.
 */
export async function validateCampaignDAG(
  campaignId: number
): Promise<{ valid: boolean; error?: string | undefined }> {
  const campaignAttacks = await listAttacks(campaignId);

  if (campaignAttacks.length === 0) {
    return { valid: true };
  }

  const attackIds = new Set(campaignAttacks.map((a) => a.id));

  // Build adjacency list and in-degree count
  const inDegree = new Map<number, number>();
  const adjacency = new Map<number, number[]>();

  for (const attack of campaignAttacks) {
    inDegree.set(attack.id, 0);
    adjacency.set(attack.id, []);
  }

  for (const attack of campaignAttacks) {
    const deps = (attack.dependencies as number[] | null) ?? [];
    for (const depId of deps) {
      if (!attackIds.has(depId)) {
        return {
          valid: false,
          error: `Attack ${attack.id} depends on non-existent attack ${depId}`,
        };
      }
      adjacency.get(depId)?.push(attack.id);
      inDegree.set(attack.id, (inDegree.get(attack.id) ?? 0) + 1);
    }
  }

  // Kahn's algorithm
  const queue: number[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) {
      queue.push(id);
    }
  }

  let processed = 0;
  while (queue.length > 0) {
    // biome-ignore lint/style/noNonNullAssertion: queue.length > 0 guarantees non-empty
    const current = queue.shift()!;
    processed++;

    for (const neighbor of adjacency.get(current) ?? []) {
      const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) {
        queue.push(neighbor);
      }
    }
  }

  if (processed !== campaignAttacks.length) {
    return { valid: false, error: 'Circular dependency detected among attacks' };
  }

  return { valid: true };
}
