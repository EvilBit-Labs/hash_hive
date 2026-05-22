import {
  attacks,
  type CampaignSortField,
  type CampaignSortOrder,
  campaigns,
  hashLists,
  hashTypes,
  maskLists,
  ruleLists,
  tasks,
  wordLists,
} from '@hashhive/shared';
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { logger } from '../config/logger.js';
import { db } from '../db/index.js';
import { MIN_CHUNK_SIZE } from './chunk-sizing.js';
import { emitCampaignStatus } from './events.js';
import { getHashListStats } from './resources.js';

// Re-export the dashboard-surface functions from the sibling module so
// existing callers (route handlers, tests) keep working through the
// `services/campaigns` import path until the next refactor sweep.
export {
  type DeleteCampaignResult,
  deleteCampaign,
  getCampaignTaskStats,
  listActiveAgentsByCampaign,
} from './campaign-dashboard.js';

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

/**
 * Inline-attack payload shape accepted by `createCampaignWithAttacks`.
 * `dependencies` carries 0-based indices into the same `attacks[]`
 * array of the request body (since attacks have no DB id until insert);
 * the service translates indices → real attack IDs after insert.
 */
export interface InlineAttackInput {
  mode: number;
  hashTypeId?: number | null | undefined;
  wordlistId?: number | null | undefined;
  rulelistId?: number | null | undefined;
  masklistId?: number | null | undefined;
  advancedConfiguration?: Record<string, unknown> | undefined;
  dependencies?: number[] | undefined;
}

export type CreateCampaignWithAttacksResult =
  | {
      kind: 'created';
      campaign: NonNullable<Awaited<ReturnType<typeof getCampaignById>>>;
      attacks: Array<{ id: number; dependencies: number[] | null }>;
    }
  | { kind: 'dag_invalid'; error: string }
  | { kind: 'resource_missing'; missing: string[] };

/**
 * Transactional create: campaign + attacks land in a single DB
 * transaction. Pre-commit DAG validation runs against the proposed
 * graph (using indices first, then real ids after insert); a cycle
 * aborts the txn so no rows are persisted.
 *
 * Attack `dependencies` values are interpreted as **0-based indices
 * into the supplied `attacks[]` array**, not real attack IDs. This
 * matches the wizard's UX where the user composes the graph before
 * any IDs exist.
 */
export async function createCampaignWithAttacks(input: {
  projectId: number;
  name: string;
  description?: string | undefined;
  hashListId: number;
  priority?: number | undefined;
  createdBy?: number | undefined;
  attacks: ReadonlyArray<InlineAttackInput>;
}): Promise<CreateCampaignWithAttacksResult> {
  // First validate the proposed DAG using index-based IDs. We use the
  // input position as a stable proxy id; this catches cycles and
  // dangling references before we open the transaction so a failed
  // validation is cheaper.
  const indexValidationInput = input.attacks.map((a, idx) => ({
    id: idx,
    dependencies: a.dependencies ?? null,
  }));
  const preCheck = validateProposedDAG(indexValidationInput);
  if (!preCheck.valid) {
    return { kind: 'dag_invalid', error: preCheck.error ?? 'Invalid DAG' };
  }

  // Cross-project resource pre-check: refuse to persist a campaign or
  // attack row whose hashList/wordlist/rulelist/masklist belongs to a
  // different project. The FK constraints only enforce existence, not
  // project ownership. Running this BEFORE the transaction lets us
  // surface a clean RESOURCE_MISSING without rolling back work.
  // hashTypes is global (no project scope) so it's matched on id only.
  const resourceCheck = await validateCampaignResources(
    { projectId: input.projectId, hashListId: input.hashListId },
    input.attacks.map((a) => ({
      hashTypeId: a.hashTypeId,
      wordlistId: a.wordlistId,
      rulelistId: a.rulelistId,
      masklistId: a.masklistId,
    }))
  );
  if (!resourceCheck.valid) {
    return { kind: 'resource_missing', missing: resourceCheck.missing };
  }

  class DAGInvalidInsideTx extends Error {
    constructor(public readonly reason: string) {
      super(reason);
    }
  }

  try {
    return await db.transaction(async (tx) => {
      const [campaign] = await tx
        .insert(campaigns)
        .values({
          projectId: input.projectId,
          name: input.name,
          description: input.description ?? null,
          hashListId: input.hashListId,
          priority: input.priority ?? 5,
          createdBy: input.createdBy ?? null,
          status: 'draft',
        })
        .returning();
      if (!campaign) {
        throw new Error('Campaign insert returned no row');
      }

      if (input.attacks.length === 0) {
        return { kind: 'created' as const, campaign, attacks: [] };
      }

      // Insert attacks one at a time so the returned id reliably
      // corresponds to the input index. Postgres does NOT guarantee
      // multi-row `INSERT ... RETURNING` row order matches the VALUES
      // order — earlier batch-insert versions of this code could
      // silently scramble dependency wiring when the planner chose a
      // non-source-order execution. Per-row insert adds n round trips
      // for n attacks, but campaign creation is bounded by the wizard
      // (typically ≤10 attacks), and the inserts are inside an open
      // transaction so latency is dominated by the txn itself.
      // Dependencies start empty; they're translated and persisted in
      // the loop below.
      const realIdByIndex: number[] = [];
      for (const a of input.attacks) {
        const [row] = await tx
          .insert(attacks)
          .values({
            campaignId: campaign.id,
            projectId: input.projectId,
            mode: a.mode,
            hashTypeId: a.hashTypeId ?? null,
            wordlistId: a.wordlistId ?? null,
            rulelistId: a.rulelistId ?? null,
            masklistId: a.masklistId ?? null,
            advancedConfiguration: a.advancedConfiguration ?? {},
            dependencies: [],
            status: 'pending' as const,
          })
          .returning({ id: attacks.id });
        if (!row) {
          throw new Error('Attack insert returned no row — txn invariant violated');
        }
        realIdByIndex.push(row.id);
      }

      // Translate and persist real-id deps; also assemble the
      // post-translation graph for the final DAG check.
      const finalGraph: Array<{ id: number; dependencies: number[] | null }> = [];
      for (let idx = 0; idx < input.attacks.length; idx++) {
        const realId = realIdByIndex[idx];
        if (realId === undefined) {
          throw new Error('Inserted attack id missing — txn invariant violated');
        }
        const indexDeps = input.attacks[idx]?.dependencies ?? [];
        const realDeps = indexDeps.map((depIdx) => {
          const target = realIdByIndex[depIdx];
          if (target === undefined) {
            throw new DAGInvalidInsideTx(
              `Attack at index ${idx} depends on out-of-range index ${depIdx}`
            );
          }
          return target;
        });
        finalGraph.push({ id: realId, dependencies: realDeps.length > 0 ? realDeps : null });

        if (realDeps.length > 0) {
          await tx
            .update(attacks)
            .set({ dependencies: realDeps, updatedAt: new Date() })
            .where(eq(attacks.id, realId));
        }
      }

      // Final safety net: re-validate the persisted graph with real
      // IDs. The pre-check on indices already caught structural
      // cycles, so this should always pass; if it fails the txn is
      // aborted via the sentinel rather than persisting a bad graph.
      const finalCheck = validateProposedDAG(finalGraph);
      if (!finalCheck.valid) {
        throw new DAGInvalidInsideTx(finalCheck.error ?? 'Invalid DAG');
      }

      return { kind: 'created' as const, campaign, attacks: finalGraph };
    });
  } catch (err) {
    if (err instanceof DAGInvalidInsideTx) {
      return { kind: 'dag_invalid', error: err.reason };
    }
    throw err;
  }
}

export type UpdateCampaignResult =
  | { kind: 'updated'; campaign: NonNullable<Awaited<ReturnType<typeof getCampaignById>>> }
  | { kind: 'not_found' }
  | { kind: 'not_draft'; status: string };

/**
 * Update a campaign if and only if its status is `draft`. The draft
 * guard is folded into the WHERE clause so a concurrent transition
 * cannot flip the row out of `draft` between a separate read-time
 * check and the write below; the post-write recheck distinguishes
 * not_found from not_draft for accurate error reporting.
 */
export async function updateCampaign(
  id: number,
  data: {
    name?: string | undefined;
    description?: string | undefined;
    priority?: number | undefined;
  }
): Promise<UpdateCampaignResult> {
  const [updated] = await db
    .update(campaigns)
    .set({ ...data, updatedAt: new Date() })
    .where(and(eq(campaigns.id, id), eq(campaigns.status, 'draft')))
    .returning();

  if (updated) {
    return { kind: 'updated', campaign: updated };
  }

  const existing = await getCampaignById(id);
  if (!existing) {
    return { kind: 'not_found' };
  }
  return { kind: 'not_draft', status: existing.status };
}

// ─── Campaign Lifecycle ─────────────────────────────────────────────

/**
 * Verify every resource referenced by the campaign and its attacks
 * actually exists, and (for project-scoped resources) belongs to the
 * campaign's project. Returns the missing resource identifiers grouped
 * by table so the route layer can surface a single combined error.
 *
 * Runs one parallel SELECT per table; all resource id lookups are
 * indexed by primary key.
 *
 * Project scoping:
 *   - `hashLists`, `wordLists`, `ruleLists`, `maskLists` have
 *     `project_id` and are scoped to the campaign's project.
 *   - `hashTypes` is global (no project_id) so it's looked up by id only.
 */
export async function validateCampaignResources(
  campaign: { projectId: number; hashListId: number | null },
  campaignAttacks: ReadonlyArray<{
    hashTypeId?: number | null | undefined;
    wordlistId?: number | null | undefined;
    rulelistId?: number | null | undefined;
    masklistId?: number | null | undefined;
  }>
): Promise<{ valid: true } | { valid: false; missing: string[] }> {
  const wantedHashListIds = campaign.hashListId ? [campaign.hashListId] : [];
  const wantedHashTypeIds = Array.from(
    new Set(campaignAttacks.map((a) => a.hashTypeId).filter((v): v is number => v != null))
  );
  const wantedWordlistIds = Array.from(
    new Set(campaignAttacks.map((a) => a.wordlistId).filter((v): v is number => v != null))
  );
  const wantedRulelistIds = Array.from(
    new Set(campaignAttacks.map((a) => a.rulelistId).filter((v): v is number => v != null))
  );
  const wantedMasklistIds = Array.from(
    new Set(campaignAttacks.map((a) => a.masklistId).filter((v): v is number => v != null))
  );

  const lookups: Array<Promise<{ table: string; foundIds: Set<number>; wanted: number[] }>> = [];

  if (wantedHashListIds.length > 0) {
    lookups.push(
      (async () => {
        const rows = await db
          .select({ id: hashLists.id })
          .from(hashLists)
          .where(
            and(
              inArray(hashLists.id, wantedHashListIds),
              eq(hashLists.projectId, campaign.projectId)
            )
          );
        return {
          table: 'hashList',
          foundIds: new Set(rows.map((r) => r.id)),
          wanted: wantedHashListIds,
        };
      })()
    );
  }
  if (wantedHashTypeIds.length > 0) {
    lookups.push(
      (async () => {
        const rows = await db
          .select({ id: hashTypes.id })
          .from(hashTypes)
          .where(inArray(hashTypes.id, wantedHashTypeIds));
        return {
          table: 'hashType',
          foundIds: new Set(rows.map((r) => r.id)),
          wanted: wantedHashTypeIds,
        };
      })()
    );
  }
  if (wantedWordlistIds.length > 0) {
    lookups.push(
      (async () => {
        const rows = await db
          .select({ id: wordLists.id })
          .from(wordLists)
          .where(
            and(
              inArray(wordLists.id, wantedWordlistIds),
              eq(wordLists.projectId, campaign.projectId)
            )
          );
        return {
          table: 'wordlist',
          foundIds: new Set(rows.map((r) => r.id)),
          wanted: wantedWordlistIds,
        };
      })()
    );
  }
  if (wantedRulelistIds.length > 0) {
    lookups.push(
      (async () => {
        const rows = await db
          .select({ id: ruleLists.id })
          .from(ruleLists)
          .where(
            and(
              inArray(ruleLists.id, wantedRulelistIds),
              eq(ruleLists.projectId, campaign.projectId)
            )
          );
        return {
          table: 'rulelist',
          foundIds: new Set(rows.map((r) => r.id)),
          wanted: wantedRulelistIds,
        };
      })()
    );
  }
  if (wantedMasklistIds.length > 0) {
    lookups.push(
      (async () => {
        const rows = await db
          .select({ id: maskLists.id })
          .from(maskLists)
          .where(
            and(
              inArray(maskLists.id, wantedMasklistIds),
              eq(maskLists.projectId, campaign.projectId)
            )
          );
        return {
          table: 'masklist',
          foundIds: new Set(rows.map((r) => r.id)),
          wanted: wantedMasklistIds,
        };
      })()
    );
  }

  if (lookups.length === 0) {
    return { valid: true };
  }

  const results = await Promise.all(lookups);
  const missing: string[] = [];
  for (const { table, foundIds, wanted } of results) {
    for (const id of wanted) {
      if (!foundIds.has(id)) {
        missing.push(`${table}(${id})`);
      }
    }
  }

  if (missing.length === 0) {
    return { valid: true };
  }
  return { valid: false, missing };
}

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

  // Validate campaign has attacks and that every referenced resource
  // still exists before starting. Resource validation runs after the
  // attack-count check so the more specific "missing resources" error
  // is preferred over the generic "no attacks" error.
  if (targetStatus === 'running') {
    const campaignAttacks = await listAttacks(id);
    if (campaignAttacks.length === 0) {
      return { error: 'Campaign must have at least one attack before starting' };
    }

    // validateCampaignResources fires 4-5 parallel SELECTs. Promise.all
    // short-circuits on rejection, so a DB blip would otherwise surface
    // as an unstructured 500. Wrap and map to a typed error so the route
    // layer returns a consistent envelope rather than letting the throw
    // bubble through the lifecycle handler.
    let resourceCheck: Awaited<ReturnType<typeof validateCampaignResources>>;
    try {
      resourceCheck = await validateCampaignResources(
        { projectId: campaign.projectId, hashListId: campaign.hashListId },
        campaignAttacks.map((a) => ({
          hashTypeId: a.hashTypeId,
          wordlistId: a.wordlistId,
          rulelistId: a.rulelistId,
          masklistId: a.masklistId,
        }))
      );
    } catch (err) {
      logger.error(
        { err, campaignId: id, projectId: campaign.projectId },
        'validateCampaignResources threw — treating as service unavailable'
      );
      return {
        error: 'Unable to validate campaign resources right now',
        code: 'RESOURCE_VALIDATION_FAILED' as const,
      };
    }
    if (!resourceCheck.valid) {
      return {
        error: `Referenced resources missing: ${resourceCheck.missing.join(', ')}`,
        code: 'RESOURCE_MISSING' as const,
      };
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

/**
 * Pure decision: should a campaign auto-transition to `completed`?
 * Triggered only when the campaign is currently `running` AND every
 * task has reached a terminal state (completed/exhausted/failed).
 * Exported for unit testing the guard without mocking SQL.
 */
export function shouldAutoCompleteCampaign(input: {
  status: string;
  totalTasks: number;
  completedCount: number;
  failedCount: number;
}): boolean {
  if (input.status !== 'running') return false;
  if (input.totalTasks <= 0) return false;
  return input.completedCount + input.failedCount >= input.totalTasks;
}

/**
 * Pure ETA estimator: project remaining-work completion from average
 * throughput since campaign start. Returns `null` when there's no
 * throughput basis (no running tasks, no startedAt, elapsed < 1s, no
 * measurable progress, or no remaining work). Exported for unit
 * testing the rate math without mocking SQL.
 */
export function computeCampaignEta(input: {
  startedAt: Date | null;
  now: Date;
  totalTasks: number;
  completedCount: number;
  failedCount: number;
  runningProgress: number;
  runningTaskCount: number;
}): string | null {
  if (input.runningTaskCount <= 0) return null;
  if (!input.startedAt) return null;
  const completedFraction = input.completedCount + input.runningProgress;
  if (completedFraction <= 0) return null;
  const elapsedMs = input.now.getTime() - input.startedAt.getTime();
  if (elapsedMs < 1000) return null;
  const rate = completedFraction / (elapsedMs / 1000); // tasks per second
  const remaining = Math.max(0, input.totalTasks - completedFraction - input.failedCount);
  if (rate <= 0 || remaining <= 0) return null;
  return new Date(input.now.getTime() + (remaining / rate) * 1000).toISOString();
}

export async function updateCampaignProgress(campaignId: number) {
  // Single aggregation query: total tasks, terminal counts, clamped running progress.
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
      failedCount: sql<number>`count(*) FILTER (WHERE ${tasks.status} = 'failed')`,
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
      runningTaskCount: sql<number>`count(*) FILTER (WHERE ${tasks.status} = 'running')`,
    })
    .from(tasks)
    .where(eq(tasks.campaignId, campaignId));

  const totalTasks = agg?.totalTasks ?? 0;
  if (totalTasks === 0) return;

  const completedCount = agg?.completedCount ?? 0;
  const failedCount = agg?.failedCount ?? 0;
  const runningProgress = agg?.runningProgress ?? 0;
  const runningTaskCount = agg?.runningTaskCount ?? 0;

  const overallProgress = (completedCount + runningProgress) / totalTasks;

  // Hash-based progress + ETA reference: load campaign metadata once.
  const [campaign] = await db
    .select({
      hashListId: campaigns.hashListId,
      status: campaigns.status,
      projectId: campaigns.projectId,
      startedAt: campaigns.startedAt,
    })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);

  let hashProgress: {
    total: number;
    cracked: number;
    remaining: number;
    percentage: number;
  } | null = null;

  if (campaign?.hashListId) {
    const stats = await getHashListStats(campaign.hashListId);

    if (stats.total > 0) {
      hashProgress = {
        ...stats,
        percentage: Math.round((stats.cracked / stats.total) * 10000) / 10000,
      };
    }
  }

  // ETA: project completion from the average rate since campaign start.
  // Estimate driven by task-completion velocity — the dashboard treats
  // it as a forecast, not a guarantee. See `computeCampaignEta` for the
  // null-handling rules.
  const eta = computeCampaignEta({
    startedAt: campaign?.startedAt ?? null,
    now: new Date(),
    totalTasks,
    completedCount,
    failedCount,
    runningProgress,
    runningTaskCount,
  });

  await db
    .update(campaigns)
    .set({
      progress: {
        totalTasks,
        completedTasks: completedCount,
        tasksFailed: failedCount,
        eta,
        overallProgress: Math.round(overallProgress * 10000) / 10000,
        updatedAt: new Date().toISOString(),
        ...(hashProgress ? { hashProgress } : {}),
      },
      updatedAt: new Date(),
    })
    .where(eq(campaigns.id, campaignId));

  // Auto-transition running → completed when every task has reached a
  // terminal state (completed/exhausted/failed). Guarded so we don't
  // fight a manual stop or recurse on an already-completed campaign.
  // transitionCampaign emits the `campaign_status` event and stamps
  // `completedAt` — we don't duplicate either here.
  //
  // Failure handling: this function is on the task-report hot path
  // (tasks.ts:updateTaskProgress). If the auto-transition throws (DB
  // blip, queue glitch), an unwrapped throw would 500 the agent's
  // `/tasks/:id/report` call *after* the task row was already
  // persisted, leaving the agent to retry against a "task already
  // completed" error and never recover. Treat the auto-transition as
  // best-effort: log and swallow. The next task-status write will
  // re-evaluate the gate and retry.
  if (
    campaign &&
    shouldAutoCompleteCampaign({
      status: campaign.status,
      totalTasks,
      completedCount,
      failedCount,
    })
  ) {
    try {
      await transitionCampaign(campaignId, 'completed');
    } catch (err) {
      logger.error(
        { err, campaignId, totalTasks, completedCount, failedCount },
        'auto-complete transitionCampaign threw; leaving for next progress write to retry'
      );
    }
  }
}

// ─── DAG Validation ─────────────────────────────────────────────────

/**
 * Pure DAG validator. Operates on an in-memory attack list so write-
 * path callers can validate the *proposed* state (current attacks ±
 * the staged change) before committing to the database. The
 * `validateCampaignDAG` wrapper reads from the DB and delegates here.
 *
 * Returns `{ valid: false, error }` when:
 *   - any dependency references an id outside the input set (covers
 *     cross-campaign references and dangling deps)
 *   - the resulting graph contains a cycle (Kahn's algorithm cannot
 *     drain all nodes)
 */
export function validateProposedDAG(
  proposedAttacks: ReadonlyArray<{ id: number; dependencies: number[] | null }>
): { valid: boolean; error?: string | undefined } {
  if (proposedAttacks.length === 0) {
    return { valid: true };
  }

  const attackIds = new Set(proposedAttacks.map((a) => a.id));

  const inDegree = new Map<number, number>();
  const adjacency = new Map<number, number[]>();

  for (const attack of proposedAttacks) {
    inDegree.set(attack.id, 0);
    adjacency.set(attack.id, []);
  }

  for (const attack of proposedAttacks) {
    const deps = attack.dependencies ?? [];
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

  if (processed !== proposedAttacks.length) {
    return { valid: false, error: 'Circular dependency detected among attacks' };
  }

  return { valid: true };
}

/**
 * DB-backed campaign DAG validator. Reads the current attack set for
 * the campaign and delegates to `validateProposedDAG`.
 */
export async function validateCampaignDAG(
  campaignId: number
): Promise<{ valid: boolean; error?: string | undefined }> {
  const campaignAttacks = await listAttacks(campaignId);
  return validateProposedDAG(
    campaignAttacks.map((a) => ({ id: a.id, dependencies: a.dependencies as number[] | null }))
  );
}
