import { attacks, campaigns, hashItems, tasks } from '@hashhive/shared';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { emitCampaignStatus } from './events.js';

// Threshold: inline generation when estimated tasks < 100, async enqueue when >= 100
export const INLINE_GENERATION_THRESHOLD = 100;
const CHUNK_SIZE = 10_000_000;

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
 * Estimates total task count and returns the generation strategy.
 * Exported for direct unit testing of the threshold boundary.
 */
export function resolveGenerationStrategy(
  attackList: ReadonlyArray<{ keyspace: string | null }>
): 'inline' | 'async' {
  let estimatedTasks = 0;
  for (const atk of attackList) {
    const keyspace = Number.parseInt(atk.keyspace ?? '0', 10);
    estimatedTasks += keyspace <= 0 ? 1 : Math.ceil(keyspace / CHUNK_SIZE);
  }
  return estimatedTasks < INLINE_GENERATION_THRESHOLD ? 'inline' : 'async';
}

// ─── Campaign CRUD ──────────────────────────────────────────────────

export async function listCampaigns(filters: {
  projectId?: number | undefined;
  status?: string | undefined;
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
  if (conditions.length > 0) {
    query = query.where(and(...conditions));
  }

  const limit = filters.limit ?? 50;
  const offset = filters.offset ?? 0;

  const [results, countResult] = await Promise.all([
    query.limit(limit).offset(offset).orderBy(desc(campaigns.createdAt)),
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
        const { generateTasksForAttack } = await _deps.getTasksModule();
        await Promise.all(campaignAttacks.map((atk) => generateTasksForAttack(atk.id)));
      } else {
        // Enqueue to the dedicated task-generation job queue
        const { getQueueManager } = await _deps.getQueueContext();
        const { QUEUE_NAMES } = await _deps.getQueueConfig();
        const { JOB_PRIORITY } = await _deps.getQueueTypes();
        const qm = getQueueManager();
        if (qm) {
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
  const campaignTasks = await db
    .select({
      status: tasks.status,
      progress: tasks.progress,
    })
    .from(tasks)
    .where(eq(tasks.campaignId, campaignId));

  if (campaignTasks.length === 0) return;

  let completedCount = 0;
  let totalProgress = 0;

  for (const t of campaignTasks) {
    if (t.status === 'completed' || t.status === 'exhausted') {
      completedCount++;
      totalProgress += 1;
    } else if (t.status === 'running') {
      const prog = (t.progress as Record<string, unknown>) ?? {};
      const kp = typeof prog['keyspaceProgress'] === 'number' ? prog['keyspaceProgress'] : 0;
      totalProgress += Math.min(kp, 1);
    }
  }

  const overallProgress = campaignTasks.length > 0 ? totalProgress / campaignTasks.length : 0;

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
    const [counts] = await db
      .select({
        total: count(),
        cracked: sql<number>`count(*) FILTER (WHERE ${hashItems.crackedAt} IS NOT NULL)`,
      })
      .from(hashItems)
      .where(eq(hashItems.hashListId, campaign.hashListId));

    const total = Number(counts?.total ?? 0);
    const cracked = Number(counts?.cracked ?? 0);

    if (total > 0) {
      hashProgress = {
        total,
        cracked,
        remaining: total - cracked,
        percentage: Math.round((cracked / total) * 10000) / 10000,
      };
    }
  }

  await db
    .update(campaigns)
    .set({
      progress: {
        totalTasks: campaignTasks.length,
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
