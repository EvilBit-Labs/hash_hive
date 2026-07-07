import {
  attacks,
  type CampaignSortField,
  type CampaignSortOrder,
  type CampaignStatus,
  campaigns,
  hashLists,
  maskLists,
  ruleLists,
  tasks,
  wordLists,
} from '@hashhive/shared'
import { and, asc, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm'

import { logger } from '../config/logger.js'
import { db } from '../db/index.js'
import { computeAttackKeyspace } from './attacks/complexity.js'
import { type AuditActor, recordAuditEvent } from './audit-log.js'
import { validateProposedDAG } from './campaign-dag.js'
import { validateCampaignResources } from './campaign-resources.js'
import { MIN_CHUNK_SIZE } from './chunk-sizing.js'
import { emitCampaignStatus } from './events.js'
import { latchResourcePermanent } from './resources.js'
import { enqueueLineCountForUncountedResources } from './resources/line-count-trigger.js'

// ─── Permanence latch (ADR-0019 / issue #106 U3) ─────────────────────
//
// Every write site that sets attacks.wordlistId/rulelistId/masklistId
// (createAttack, updateAttack, and the per-attack insert loop in
// createCampaignWithAttacks) funnels through this helper so a word/rule/mask
// list becomes permanent the moment it is first referenced. Called with the
// attack row's CURRENT (post-write) values — not the caller's raw input —
// so it latches whichever resource is actually in effect after the write,
// covering both "new reference on create" and "swapped to a new resource on
// update" uniformly. Must run inside the same transaction as the attack
// write (see latchResourcePermanent).
async function latchAttackResources(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  attack: {
    wordlistId: number | null
    rulelistId: number | null
    masklistId: number | null
  }
): Promise<void> {
  if (attack.wordlistId != null) {
    await latchResourcePermanent(tx, wordLists, attack.wordlistId)
  }
  if (attack.rulelistId != null) {
    await latchResourcePermanent(tx, ruleLists, attack.rulelistId)
  }
  if (attack.masklistId != null) {
    await latchResourcePermanent(tx, maskLists, attack.masklistId)
  }
}

type CampaignsDbTx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Latch an attack's `is_permanent = true` the first time it generates a
 * task row (issue #106 U6) — the attack analog of `latchResourcePermanent`
 * for word/rule/mask lists (see resources.ts). One-way: the guarded
 * `WHERE isPermanent = false` makes a repeat call on an already-permanent
 * attack a no-op, so `generateTasksForAttack` (services/tasks.ts) can
 * invoke this unconditionally on every generation run — including the
 * "already has tasks" re-generation path — without checking current state
 * first. Must run inside the same transaction as the task-creating INSERT
 * so a crash between the two can never leave a run attack un-latched.
 */
export async function latchAttackPermanent(tx: CampaignsDbTx, attackId: number): Promise<void> {
  await tx
    .update(attacks)
    .set({ isPermanent: true, updatedAt: new Date() })
    .where(and(eq(attacks.id, attackId), eq(attacks.isPermanent, false)))
}

export { validateCampaignDAG, validateProposedDAG } from './campaign-dag.js'
// Re-export from sibling modules so existing callers (route handlers,
// tests) keep working through the `services/campaigns` import path.
// The split brought this file near the 800-line project guideline
// (down from 1,500+) without forcing every caller to update its
// import path; further growth should land in one of the sibling
// modules instead of bloating this facade.
export {
  type DeleteCampaignResult,
  deleteCampaign,
  getCampaignTaskStats,
  listActiveAgentsByCampaign,
} from './campaign-dashboard.js'
// Re-export the read-time attack runtime builder so the dashboard detail route
// imports it from the same `services/campaigns` facade as its sibling
// payload builders (keeps that route's service mock to one module).
export { getCampaignAttacksWithRuntime } from './attacks/runtime.js'
// Campaign-level ETA rollup (issue #100 U1) — re-exported here so the
// detail/list routes (U2) reach it through the same facade as every other
// campaign payload builder above. `computeCampaignEtaState` is the pure
// precedence ladder: the detail route calls it directly over the attack
// runtimes it already fetched (getCampaignAttacksWithRuntime) rather than
// going through `getCampaignEta`, which would re-fetch and re-derive the
// same attacks a second time. The list route has no such fetch to reuse, so
// it calls the I/O batch entry point (`getCampaignEtasBatch`) instead.
export {
  type AttackEtaInput,
  computeCampaignEtaState,
  getCampaignEta,
  getCampaignEtasBatch,
} from './campaign-eta-rollup.js'
export {
  _progressDeps,
  computeCampaignEta,
  shouldAutoCompleteCampaign,
  updateCampaignProgress,
} from './campaign-progress.js'
export { findReclaimedResourceRefs, validateCampaignResources } from './campaign-resources.js'
// Attack archive/restore (issue #106 U6) — mirrors the resources-archive.ts
// split: kept out of this file to stay under the 800-line guideline,
// re-exported here so callers use the same `services/campaigns` facade as
// every other attack-management function.
export { archiveAttacks, restoreAttacks } from './campaigns-attacks-archive.js'

// Threshold: inline generation when estimated tasks < 100, async enqueue when >= 100
export const INLINE_GENERATION_THRESHOLD = 100
// Use the smallest possible runtime chunk size as the estimator's basis so
// the chunk-count estimate is an upper bound on what generateTasksForAttack
// will actually emit. pickChunkSize can clamp as low as MIN_CHUNK_SIZE for
// slow fleets, so using the legacy 10M constant would let attacks slip
// through the inline gate and then materialize 4 orders of magnitude more
// rows in the request path.
const CHUNK_SIZE = Number(MIN_CHUNK_SIZE)

// Dynamic import getters — break circular dependency (campaigns ↔ tasks) while
// remaining testable. bun:test's mock.module cannot override already-cached
// dynamic imports across test files, so tests swap these getters instead.
export const _deps = {
  getTasksModule: () => import('./tasks.js'),
  getQueueContext: () => import('../queue/context.js'),
  getQueueConfig: () => import('../config/queue.js'),
  getQueueTypes: () => import('../queue/types.js'),
}

/**
 * Enqueue a preemption evaluation for a project (issue #97). Best-effort:
 * preemption is a background optimization, so a missing queue or an enqueue
 * failure must never fail the originating campaign transition or priority
 * change. Deduped per project via a deterministic jobId so a burst of
 * triggers collapses to a single evaluation.
 */
export async function enqueuePreemptionEvaluation(projectId: number): Promise<void> {
  try {
    const { getQueueManager } = await _deps.getQueueContext()
    const { QUEUE_NAMES } = await _deps.getQueueConfig()
    const qm = getQueueManager()
    if (!qm) return
    await qm.enqueue(QUEUE_NAMES.PREEMPTION, { projectId }, { jobId: `preempt:${projectId}` })
  } catch (err: unknown) {
    logger.warn({ err, projectId }, 'failed to enqueue preemption evaluation')
  }
}

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
  mode?: number | null | undefined
  wordlistId?: number | null | undefined
  masklistId?: number | null | undefined
  advancedConfiguration?: unknown
}): boolean {
  if (atk.mode === undefined || atk.mode === null) return false
  const mask =
    atk.advancedConfiguration &&
    typeof atk.advancedConfiguration === 'object' &&
    typeof (atk.advancedConfiguration as Record<string, unknown>)['mask'] === 'string'
      ? ((atk.advancedConfiguration as Record<string, unknown>)['mask'] as string)
      : null
  switch (atk.mode) {
    case 0:
      return atk.wordlistId != null
    case 3:
      return mask !== null && mask.length > 0
    case 6:
    case 7:
      return atk.wordlistId != null && mask !== null && mask.length > 0
    default:
      return false
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
    keyspace: string | null
    mode?: number | null | undefined
    wordlistId?: number | null | undefined
    masklistId?: number | null | undefined
    advancedConfiguration?: unknown
  }>
): 'inline' | 'async' {
  let estimatedTasks = 0
  const chunkSize = BigInt(CHUNK_SIZE)
  for (const atk of attackList) {
    const raw = atk.keyspace?.trim()
    if (!raw || raw === '0') {
      // Null / zero / blank keyspace.
      if (isAttackKeyspaceComputable(atk)) {
        // generateTasksForAttack will compute the real keyspace and
        // may generate up to MAX_CHUNKS_PER_ATTACK chunks inline.
        // Force async so the request path doesn't block on the burst.
        return 'async'
      }
      // Calculator will fall through to a single placeholder task.
      estimatedTasks += 1
      continue
    }
    let bigKs: bigint
    try {
      bigKs = BigInt(raw)
    } catch {
      estimatedTasks += 1
      continue
    }
    if (bigKs <= 0n) {
      estimatedTasks += 1
      continue
    }
    const chunks = bigKs / chunkSize + (bigKs % chunkSize === 0n ? 0n : 1n)
    // Saturate at INLINE_GENERATION_THRESHOLD so the comparison stays
    // within safe-Number range even for astronomical keyspaces.
    estimatedTasks +=
      chunks > BigInt(INLINE_GENERATION_THRESHOLD) ? INLINE_GENERATION_THRESHOLD : Number(chunks)
    if (estimatedTasks >= INLINE_GENERATION_THRESHOLD) return 'async'
  }
  return estimatedTasks < INLINE_GENERATION_THRESHOLD ? 'inline' : 'async'
}

// ─── Campaign CRUD ──────────────────────────────────────────────────

const SORT_COLUMNS = {
  name: campaigns.name,
  createdAt: campaigns.createdAt,
  priority: campaigns.priority,
} as const

export async function listCampaigns(filters: {
  projectId?: number | undefined
  status?: string | undefined
  priority?: number | undefined
  showArchived?: boolean | undefined
  sort?: CampaignSortField | undefined
  order?: CampaignSortOrder | undefined
  limit?: number | undefined
  offset?: number | undefined
}) {
  let query = db.select().from(campaigns).$dynamic()

  const conditions = []
  if (filters.projectId) {
    conditions.push(eq(campaigns.projectId, filters.projectId))
  }
  if (filters.status) {
    conditions.push(eq(campaigns.status, filters.status))
  }
  if (filters.priority !== undefined) {
    conditions.push(eq(campaigns.priority, filters.priority))
  }
  // Archived campaigns are excluded from active list views by default
  // (ADR-0019); pass showArchived to include them. Applies to both the data
  // and count queries since they share this conditions array.
  if (!filters.showArchived) {
    conditions.push(isNull(campaigns.archivedAt))
  }
  if (conditions.length > 0) {
    query = query.where(and(...conditions))
  }

  const limit = filters.limit ?? 50
  const offset = filters.offset ?? 0

  const sortField = filters.sort ?? 'createdAt'
  const sortOrder = filters.order ?? 'desc'
  const sortColumn = SORT_COLUMNS[sortField]
  const orderClause = sortOrder === 'asc' ? asc(sortColumn) : desc(sortColumn)

  const [results, countResult] = await Promise.all([
    query.limit(limit).offset(offset).orderBy(orderClause),
    db
      .select({ count: sql<number>`count(*)` })
      .from(campaigns)
      .where(conditions.length > 0 ? and(...conditions) : undefined),
  ])

  return {
    campaigns: results,
    total: Number(countResult[0]?.count ?? 0),
    limit,
    offset,
  }
}

export async function getCampaignById(id: number) {
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1)
  return campaign ?? null
}

export async function createCampaign(
  data: {
    projectId: number
    name: string
    description?: string | undefined
    hashListId: number
    priority?: number | undefined
    createdBy?: number | undefined
  },
  actor: AuditActor = {
    actorType: 'system',
    actorId: null,
  }
) {
  return db.transaction(async (tx) => {
    const [campaign] = await tx
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
      .returning()

    if (!campaign) return null

    // Permanence latch (ADR-0019 / issue #106 U3): a hash list becomes
    // referenced the moment a campaign is created against it, regardless of
    // the campaign's own draft/permanent state. One-way and idempotent — see
    // latchResourcePermanent.
    await latchResourcePermanent(tx, hashLists, campaign.hashListId)

    await recordAuditEvent(
      {
        actor,
        projectId: data.projectId,
        entityType: 'campaign',
        entityId: campaign.id,
        action: 'created',
        newRow: campaign as Record<string, unknown>,
      },
      tx
    )

    return campaign
  })
}

/**
 * Inline-attack payload shape accepted by `createCampaignWithAttacks`.
 *
 * `dependencyIndices` carries **0-based indices into the same
 * `attacks[]` array** of the request body (since attacks have no DB
 * id until insert); the service translates indices → real attack IDs
 * after insert. The field is named distinctly from `dependencies` on
 * `createAttack` (which carries real attack IDs) so the two semantics
 * cannot be confused at the call site or on the wire.
 */
export interface InlineAttackInput {
  mode: number
  hashTypeId?: number | null | undefined
  wordlistId?: number | null | undefined
  rulelistId?: number | null | undefined
  masklistId?: number | null | undefined
  advancedConfiguration?: Record<string, unknown> | undefined
  dependencyIndices?: number[] | undefined
}

export type CreateCampaignWithAttacksResult =
  | {
      kind: 'created'
      campaign: NonNullable<Awaited<ReturnType<typeof getCampaignById>>>
      attacks: Array<{ id: number; dependencies: number[] | null }>
    }
  | { kind: 'dag_invalid'; error: string }
  | { kind: 'resource_missing'; missing: string[] }
  // A referenced word/rule/mask list is a reclaimed shell (issue #106 U12 /
  // R12) — present, but unusable until re-uploaded and checksum-verified.
  | { kind: 'resource_reclaimed'; reclaimed: string[] }
  // A referenced hash list / word/rule/mask list is archived (issue #106
  // F5 code review) — present, but hidden from listings and refused as a
  // reference for new work.
  | { kind: 'resource_archived'; archived: string[] }

/**
 * Transactional create: campaign + attacks land in a single DB
 * transaction. Pre-commit DAG validation runs against the proposed
 * graph (using indices first, then real ids after insert); a cycle
 * aborts the txn so no rows are persisted.
 *
 * Each `InlineAttackInput.dependencyIndices` value is a 0-based index
 * into the supplied `attacks[]` array, NOT a real attack id (since
 * attacks have no DB id until insert). The service translates
 * indices → real ids after insert. This matches the wizard's UX
 * where the user composes the graph before any IDs exist.
 */
export async function createCampaignWithAttacks(input: {
  projectId: number
  name: string
  description?: string | undefined
  hashListId: number
  priority?: number | undefined
  createdBy?: number | undefined
  attacks: ReadonlyArray<InlineAttackInput>
  actor?: AuditActor | undefined
}): Promise<CreateCampaignWithAttacksResult> {
  const actor = input.actor ?? { actorType: 'system' as const, actorId: null }
  // First validate the proposed DAG using index-based IDs. We use the
  // input position as a stable proxy id; this catches cycles and
  // dangling references before we open the transaction so a failed
  // validation is cheaper.
  const indexValidationInput = input.attacks.map((a, idx) => ({
    id: idx,
    dependencies: a.dependencyIndices ?? null,
  }))
  const preCheck = validateProposedDAG(indexValidationInput)
  if (!preCheck.valid) {
    return { kind: 'dag_invalid', error: preCheck.error ?? 'Invalid DAG' }
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
  )
  if (!resourceCheck.valid) {
    if (resourceCheck.reclaimed.length > 0) {
      return { kind: 'resource_reclaimed', reclaimed: resourceCheck.reclaimed }
    }
    if (resourceCheck.archived.length > 0) {
      return { kind: 'resource_archived', archived: resourceCheck.archived }
    }
    return { kind: 'resource_missing', missing: resourceCheck.missing }
  }

  // Pre-compute each attack's keyspace from its resources' line counts before
  // opening the transaction (the resources were just validated to exist).
  // Stored on the row so generation consumes it rather than recomputing; null
  // when a line count isn't known yet, in which case the line-count worker
  // recomputes once the resource is counted.
  const keyspaceByIndex = await Promise.all(input.attacks.map((a) => computeAttackKeyspace(a)))

  class DAGInvalidInsideTx extends Error {
    constructor(public readonly reason: string) {
      super(reason)
    }
  }

  let result: CreateCampaignWithAttacksResult
  try {
    result = await db.transaction(async (tx) => {
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
        .returning()
      if (!campaign) {
        throw new Error('Campaign insert returned no row')
      }

      // Permanence latch (ADR-0019 / issue #106 U3): see createCampaign.
      await latchResourcePermanent(tx, hashLists, campaign.hashListId)

      await recordAuditEvent(
        {
          actor,
          projectId: input.projectId,
          entityType: 'campaign',
          entityId: campaign.id,
          action: 'created',
          newRow: campaign as Record<string, unknown>,
        },
        tx
      )

      if (input.attacks.length === 0) {
        return { kind: 'created' as const, campaign, attacks: [] }
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
      const realIdByIndex: number[] = []
      for (const [idx, a] of input.attacks.entries()) {
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
            keyspace: keyspaceByIndex[idx] ?? null,
          })
          .returning()
        if (!row) {
          throw new Error('Attack insert returned no row — txn invariant violated')
        }
        realIdByIndex.push(row.id)

        // Permanence latch (ADR-0019 / issue #106 U3): see latchAttackResources.
        await latchAttackResources(tx, row)

        await recordAuditEvent(
          {
            actor,
            projectId: input.projectId,
            entityType: 'attack',
            entityId: row.id,
            action: 'created',
            newRow: row as Record<string, unknown>,
          },
          tx
        )
      }

      // Translate index-based deps → real-id deps and persist. The
      // index-to-id mapping is bijective (per-row insert above gives a
      // deterministic order) and validateProposedDAG already ran
      // structurally on the index form, so no post-translation cycle
      // check is needed — every edge present in the real-id graph has a
      // corresponding edge in the index graph that was already proven
      // acyclic. The only remaining failure mode is an out-of-range
      // index, which is caught point-of-use below.
      const finalGraph: Array<{ id: number; dependencies: number[] | null }> = []
      for (let idx = 0; idx < input.attacks.length; idx++) {
        const realId = realIdByIndex[idx]
        if (realId === undefined) {
          throw new Error('Inserted attack id missing — txn invariant violated')
        }
        const indexDeps = input.attacks[idx]?.dependencyIndices ?? []
        const realDeps = indexDeps.map((depIdx) => {
          const target = realIdByIndex[depIdx]
          if (target === undefined) {
            throw new DAGInvalidInsideTx(
              `Attack at index ${idx} depends on out-of-range index ${depIdx}`
            )
          }
          return target
        })
        finalGraph.push({ id: realId, dependencies: realDeps.length > 0 ? realDeps : null })

        if (realDeps.length > 0) {
          await tx
            .update(attacks)
            .set({ dependencies: realDeps, updatedAt: new Date() })
            .where(eq(attacks.id, realId))
        }
      }

      return { kind: 'created' as const, campaign, attacks: finalGraph }
    })
  } catch (err) {
    if (err instanceof DAGInvalidInsideTx) {
      return { kind: 'dag_invalid', error: err.reason }
    }
    throw err
  }

  // After commit: best-effort line-count enqueue for any attack whose keyspace
  // couldn't be computed inline (its wordlist/rulelist isn't counted yet). Done
  // post-commit so the count worker's fan-out sees the freshly persisted rows.
  if (result.kind === 'created') {
    await Promise.all(
      input.attacks.map((a, idx) =>
        keyspaceByIndex[idx] === null
          ? enqueueLineCountForUncountedResources({
              wordlistId: a.wordlistId ?? null,
              rulelistId: a.rulelistId ?? null,
              masklistId: a.masklistId ?? null,
              projectId: input.projectId,
            })
          : Promise.resolve()
      )
    )
  }

  return result
}

export type UpdateCampaignResult =
  | { kind: 'updated'; campaign: NonNullable<Awaited<ReturnType<typeof getCampaignById>>> }
  | { kind: 'not_found' }
  | { kind: 'not_draft'; status: string }

/**
 * Update a campaign if and only if its status is `draft`. The draft
 * guard is folded into the WHERE clause so a concurrent transition
 * cannot flip the row out of `draft` between a separate read-time
 * check and the write below; the post-write recheck distinguishes
 * not_found from not_draft for accurate error reporting.
 *
 * Wrapped in a transaction so the audit row is atomic with the UPDATE.
 */
export async function updateCampaign(
  id: number,
  projectId: number,
  data: {
    name?: string | undefined
    // PUT requests can pass `null` to explicitly clear the description;
    // PATCH requests omit the field entirely (undefined) to leave it
    // untouched. The Drizzle `.set()` call below only writes keys
    // present in `data`, so `undefined` is skipped while `null` is
    // persisted.
    description?: string | null | undefined
    priority?: number | undefined
  },
  actor: AuditActor = {
    actorType: 'system',
    actorId: null,
  }
): Promise<UpdateCampaignResult> {
  return db.transaction(async (tx) => {
    // Fetch the old row inside the tx so we have it for the audit diff.
    // The draft guard in the WHERE is what actually keeps a contributor
    // in project A from updating a campaign in project B by guessing its id;
    // this SELECT is the old-row snapshot for the audit trail.
    const [oldRow] = await tx
      .select()
      .from(campaigns)
      .where(
        and(eq(campaigns.id, id), eq(campaigns.projectId, projectId), eq(campaigns.status, 'draft'))
      )
      .limit(1)

    if (!oldRow) {
      // Disambiguate: check whether the row exists at all (in this project)
      // to distinguish not_found from not_draft for accurate error reporting.
      const [existing] = await tx
        .select()
        .from(campaigns)
        .where(and(eq(campaigns.id, id), eq(campaigns.projectId, projectId)))
        .limit(1)
      if (!existing) return { kind: 'not_found' }
      return { kind: 'not_draft', status: existing.status }
    }

    const [updated] = await tx
      .update(campaigns)
      .set({ ...data, updatedAt: new Date() })
      .where(
        and(eq(campaigns.id, id), eq(campaigns.projectId, projectId), eq(campaigns.status, 'draft'))
      )
      .returning()

    if (!updated) {
      // Race: draft guard lost between our SELECT and UPDATE.
      return { kind: 'not_draft', status: oldRow.status }
    }

    await recordAuditEvent(
      {
        actor,
        projectId,
        entityType: 'campaign',
        entityId: id,
        action: 'updated',
        oldRow: oldRow as Record<string, unknown>,
        newRow: updated as Record<string, unknown>,
      },
      tx
    )

    return { kind: 'updated', campaign: updated }
  })
}

export type ChangePriorityResult =
  | { kind: 'updated'; campaign: NonNullable<Awaited<ReturnType<typeof getCampaignById>>> }
  | { kind: 'not_found' }
  | { kind: 'not_active'; status: string }

/**
 * Change a **running or paused** campaign's priority (issue #97 U7). This is
 * the only path that can re-prioritise a live campaign — `updateCampaign`'s
 * draft guard rejects it, and a draft campaign has no running tasks to
 * compete for agents. The status bound is folded into the UPDATE WHERE
 * (mirroring the draft guard) so a campaign that transitioned to a terminal
 * state concurrently is not mutated. A successful change re-evaluates
 * preemption for the project (trigger a).
 *
 * Wrapped in a transaction so the audit row is atomic with the UPDATE.
 * `enqueuePreemptionEvaluation` runs OUTSIDE the transaction (queue enqueue).
 */
export async function changeRunningCampaignPriority(
  id: number,
  projectId: number,
  priority: number,
  actor: AuditActor = {
    actorType: 'system',
    actorId: null,
  }
): Promise<ChangePriorityResult> {
  const result = await db.transaction(async (tx) => {
    const [oldRow] = await tx
      .select()
      .from(campaigns)
      .where(
        and(
          eq(campaigns.id, id),
          eq(campaigns.projectId, projectId),
          inArray(campaigns.status, ['running', 'paused'])
        )
      )
      .limit(1)

    if (!oldRow) {
      const [existing] = await tx
        .select()
        .from(campaigns)
        .where(and(eq(campaigns.id, id), eq(campaigns.projectId, projectId)))
        .limit(1)
      if (!existing) return { kind: 'not_found' as const }
      return { kind: 'not_active' as const, status: existing.status }
    }

    const [updated] = await tx
      .update(campaigns)
      .set({ priority, updatedAt: new Date() })
      .where(
        and(
          eq(campaigns.id, id),
          eq(campaigns.projectId, projectId),
          inArray(campaigns.status, ['running', 'paused'])
        )
      )
      .returning()

    if (!updated) {
      return { kind: 'not_active' as const, status: oldRow.status }
    }

    await recordAuditEvent(
      {
        actor,
        projectId,
        entityType: 'campaign',
        entityId: id,
        action: 'updated',
        oldRow: oldRow as Record<string, unknown>,
        newRow: updated as Record<string, unknown>,
      },
      tx
    )

    return { kind: 'updated' as const, campaign: updated }
  })

  // enqueuePreemptionEvaluation must run outside the transaction
  if (result.kind === 'updated') {
    await enqueuePreemptionEvaluation(projectId)
  }
  return result
}

// ─── Campaign Lifecycle ─────────────────────────────────────────────
//
// Cross-project resource validation lives in `campaign-resources.ts`
// (re-exported above). The DAG validator lives in `campaign-dag.ts`.
// Progress aggregation + auto-completion lives in
// `campaign-progress.ts`. Splitting kept this file under the project's
// 800-line guideline without changing the public import surface.

// `CampaignStatus` is the canonical lifecycle vocabulary exported from
// `@hashhive/shared` (`campaignStatusSchema`). The transition table
// is keyed by the same vocabulary so adding a new status to the shared
// enum forces this table to be updated in the same change (the
// `Record<CampaignStatus, ...>` typing turns a missing key into a
// compile error).
const VALID_TRANSITIONS: Record<CampaignStatus, CampaignStatus[]> = {
  draft: ['running', 'cancelled'],
  running: ['paused', 'completed', 'cancelled', 'draft'],
  // paused → completed is permitted so the auto-complete gate can fire
  // when the last in-flight task of a paused campaign reaches a
  // terminal state. Without this edge, a paused campaign whose tasks
  // happened to finish during the pause window would sit at 'paused'
  // indefinitely with no further trigger to flip it to 'completed'.
  paused: ['running', 'completed', 'cancelled', 'draft'],
  completed: [],
  cancelled: [],
}

export async function transitionCampaign(
  id: number,
  targetStatus: CampaignStatus,
  actor: AuditActor = {
    actorType: 'system',
    actorId: null,
  }
) {
  const campaign = await getCampaignById(id)
  if (!campaign) {
    return { error: 'Campaign not found' }
  }

  // Capture before any mutation so the audit trail records the real pre-image.
  const fromStatus = campaign.status

  // `campaign.status` is typed `string` from the DB row but the
  // transition table is keyed by `CampaignStatus`. Cast at the lookup
  // boundary — an unknown DB literal falls through to `[]` via `??`,
  // producing the canonical "cannot transition" error path.
  const allowed = VALID_TRANSITIONS[campaign.status as CampaignStatus] ?? []
  if (!allowed.includes(targetStatus)) {
    return {
      error: `Cannot transition from '${campaign.status}' to '${targetStatus}'`,
    }
  }

  // Validate campaign has attacks and that every referenced resource
  // still exists before starting. Resource validation runs after the
  // attack-count check so the more specific "missing resources" error
  // is preferred over the generic "no attacks" error.
  if (targetStatus === 'running') {
    const campaignAttacks = await listAttacks(id)
    if (campaignAttacks.length === 0) {
      return { error: 'Campaign must have at least one attack before starting' }
    }

    // validateCampaignResources fires 4-5 parallel SELECTs. Promise.all
    // short-circuits on rejection, so a DB blip would otherwise surface
    // as an unstructured 500. Wrap and map to a typed error so the route
    // layer returns a consistent envelope rather than letting the throw
    // bubble through the lifecycle handler.
    let resourceCheck: Awaited<ReturnType<typeof validateCampaignResources>>
    try {
      resourceCheck = await validateCampaignResources(
        { projectId: campaign.projectId, hashListId: campaign.hashListId },
        campaignAttacks.map((a) => ({
          hashTypeId: a.hashTypeId,
          wordlistId: a.wordlistId,
          rulelistId: a.rulelistId,
          masklistId: a.masklistId,
        }))
      )
    } catch (err) {
      logger.error(
        { err, campaignId: id, projectId: campaign.projectId },
        'validateCampaignResources threw — treating as service unavailable'
      )
      return {
        error: 'Unable to validate campaign resources right now',
        code: 'RESOURCE_VALIDATION_FAILED' as const,
      }
    }
    if (!resourceCheck.valid) {
      if (resourceCheck.reclaimed.length > 0) {
        return {
          error: `Referenced resources are reclaimed shells (re-upload required): ${resourceCheck.reclaimed.join(', ')}`,
          code: 'RESOURCE_RECLAIMED' as const,
        }
      }
      if (resourceCheck.archived.length > 0) {
        return {
          error: `Referenced resources are archived: ${resourceCheck.archived.join(', ')}`,
          code: 'RESOURCE_ARCHIVED' as const,
        }
      }
      return {
        error: `Referenced resources missing: ${resourceCheck.missing.join(', ')}`,
        code: 'RESOURCE_MISSING' as const,
      }
    }
  }

  // When starting/resuming a campaign, verify queue availability before transitioning
  if (targetStatus === 'running') {
    const { getQueueManager } = await _deps.getQueueContext()
    const qm = getQueueManager()
    if (!qm) {
      return {
        error: 'Queue unavailable — cannot start campaign',
        code: 'QUEUE_UNAVAILABLE' as const,
      }
    }
    const health = await qm.getHealth()
    if (health.status === 'disconnected') {
      return {
        error: 'Queue unavailable — cannot start campaign',
        code: 'QUEUE_UNAVAILABLE' as const,
      }
    }
  }

  // Stop action: running/paused → draft means cancel non-terminal tasks and
  // reset. `'paused'` is included (#97 U8) so preempted-paused tasks are
  // cancelled rather than orphaned: a paused task is excluded from the stale
  // sweep, so without this it would sit `paused` forever with a dangling
  // agent_id + preempted_by_campaign_id after its campaign stops.
  if (targetStatus === 'draft' && (campaign.status === 'running' || campaign.status === 'paused')) {
    await db
      .update(tasks)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(
        and(
          eq(tasks.campaignId, id),
          sql`${tasks.status} IN ('pending', 'assigned', 'running', 'paused')`
        )
      )
  }

  const updates: Record<string, unknown> = {
    status: targetStatus,
    updatedAt: new Date(),
  }

  if (targetStatus === 'running' && !campaign.startedAt) {
    updates['startedAt'] = new Date()
  }
  if (targetStatus === 'completed' || targetStatus === 'cancelled') {
    updates['completedAt'] = new Date()
  }
  // Permanence latch (ADR-0019): the first time a campaign leaves draft it
  // becomes a permanent record — archive-only, never hard-deleted. Set in the
  // same atomic UPDATE; idempotent on later transitions (re-editing returns a
  // permanent campaign to draft, but the flag is never cleared).
  if (campaign.status === 'draft' && targetStatus !== 'draft') {
    updates['isPermanent'] = true
  }
  // Stop resets timestamps
  if (targetStatus === 'draft') {
    updates['startedAt'] = null
    updates['completedAt'] = null
    updates['progress'] = {}
  }

  // Source-status guard: fold the read-time status into the UPDATE
  // WHERE so a concurrent transition (e.g. auto-complete racing with
  // manual stop, or two parallel /lifecycle requests) cannot both
  // succeed. The first writer flips the row; the second observes 0
  // affected rows and returns a stale-state error so the caller can
  // re-fetch and decide. Same pattern the `updateCampaign` draft guard
  // uses.
  const [updated] = await db
    .update(campaigns)
    .set(updates)
    .where(and(eq(campaigns.id, id), eq(campaigns.status, campaign.status)))
    .returning()

  if (!updated) {
    return {
      error: `Campaign status changed during transition (was '${campaign.status}'); retry against the current state`,
      code: 'STALE_STATE' as const,
    }
  }

  // Emit status for non-running transitions immediately; for 'running',
  // defer until after task generation enqueue succeeds to avoid premature events.
  if (targetStatus !== 'running') {
    emitCampaignStatus(campaign.projectId, id, targetStatus)
    // A campaign reaching a terminal/draft state frees its agents and clears
    // its pending work — re-evaluate preemption so victims (of its or other
    // preemptions) can resume (#97 U6). This is what covers the
    // cancelled-preemptor case where no task completion would otherwise fire
    // the resume trigger.
    if (targetStatus === 'completed' || targetStatus === 'cancelled' || targetStatus === 'draft') {
      await enqueuePreemptionEvaluation(campaign.projectId)
    }
  }

  // When starting a campaign, generate tasks — inline if few, queued if many
  if (targetStatus === 'running') {
    const campaignAttacks = await listAttacks(id)
    if (campaignAttacks.length > 0) {
      const strategy = resolveGenerationStrategy(campaignAttacks)

      if (strategy === 'inline') {
        // Generate inline in parallel — small enough to not block the request meaningfully
        try {
          const { generateTasksForAttack } = await _deps.getTasksModule()
          await Promise.all(campaignAttacks.map((atk) => generateTasksForAttack(atk.id)))
        } catch (err) {
          logger.error(
            { err, campaignId: id, projectId: campaign.projectId },
            'inline task generation failed during start, rolling back'
          )
          // Roll back — inline task generation failed
          await db
            .update(campaigns)
            .set({
              status: campaign.status,
              startedAt: campaign.startedAt,
              completedAt: campaign.completedAt,
              progress: campaign.progress ?? {},
              // Restore the permanence latch too (ADR-0019): a failed start did
              // not successfully leave draft, so a pristine draft must not be
              // left permanent — otherwise it becomes silently undeletable.
              isPermanent: campaign.isPermanent,
              updatedAt: new Date(),
            })
            // Guard on the status we just set so a concurrent transition (e.g.
            // auto-complete) is not clobbered by this rollback.
            .where(and(eq(campaigns.id, id), eq(campaigns.status, 'running')))
          return { error: 'Task generation failed', code: 'TASK_GENERATION_FAILED' as const }
        }
      } else {
        // Enqueue to the dedicated task-generation job queue
        const { getQueueManager } = await _deps.getQueueContext()
        const { QUEUE_NAMES } = await _deps.getQueueConfig()
        const { JOB_PRIORITY } = await _deps.getQueueTypes()
        const qm = getQueueManager()
        if (!qm) {
          // Roll back — queue disappeared between health check and enqueue
          await db
            .update(campaigns)
            .set({
              status: campaign.status,
              startedAt: campaign.startedAt,
              completedAt: campaign.completedAt,
              progress: campaign.progress ?? {},
              // Restore the permanence latch too (ADR-0019): a failed start did
              // not successfully leave draft, so a pristine draft must not be
              // left permanent — otherwise it becomes silently undeletable.
              isPermanent: campaign.isPermanent,
              updatedAt: new Date(),
            })
            // Guard on the status we just set so a concurrent transition (e.g.
            // auto-complete) is not clobbered by this rollback.
            .where(and(eq(campaigns.id, id), eq(campaigns.status, 'running')))
          return {
            error: 'Queue unavailable — cannot start campaign',
            code: 'QUEUE_UNAVAILABLE' as const,
          }
        }

        const priorityMap: Record<number, number> = {
          1: JOB_PRIORITY.HIGH,
          5: JOB_PRIORITY.NORMAL,
          10: JOB_PRIORITY.LOW,
        }
        const jobPriority = priorityMap[campaign.priority] ?? JOB_PRIORITY.NORMAL

        const enqueued = await qm.enqueue(QUEUE_NAMES.TASK_GENERATION, {
          campaignId: id,
          projectId: campaign.projectId,
          attackIds: campaignAttacks.map((a) => a.id),
          priority: jobPriority as 1 | 5 | 10,
        })

        if (!enqueued) {
          // Roll back the entire status transition including timestamps/progress
          await db
            .update(campaigns)
            .set({
              status: campaign.status,
              startedAt: campaign.startedAt,
              completedAt: campaign.completedAt,
              progress: campaign.progress ?? {},
              // Restore the permanence latch too (ADR-0019): a failed start did
              // not successfully leave draft, so a pristine draft must not be
              // left permanent — otherwise it becomes silently undeletable.
              isPermanent: campaign.isPermanent,
              updatedAt: new Date(),
            })
            // Guard on the status we just set so a concurrent transition (e.g.
            // auto-complete) is not clobbered by this rollback.
            .where(and(eq(campaigns.id, id), eq(campaigns.status, 'running')))
          return {
            error: 'Failed to enqueue task generation',
            code: 'QUEUE_UNAVAILABLE' as const,
          }
        }
      }
    }

    // Emit after successful generation/enqueue
    if (updated) {
      emitCampaignStatus(campaign.projectId, id, targetStatus)
      // A new campaign starting may starve higher-priority pending work of
      // agents (or free agents that paused lower-priority work) — evaluate
      // preemption for the project (#97 U5, trigger b).
      await enqueuePreemptionEvaluation(campaign.projectId)
    }
  }

  // Audit the committed transition. Uses db directly (no tx available here —
  // the function's compensating-rollback choreography prevents wrapping the
  // status UPDATE in a transaction). Errors propagate per R4. Only fires on
  // the single committed-success path; all early-return and compensating-
  // rollback paths return before reaching here.
  await recordAuditEvent({
    actor,
    projectId: campaign.projectId,
    entityType: 'campaign',
    entityId: id,
    action: 'status_changed',
    fromStatus,
    toStatus: targetStatus,
    oldRow: campaign as Record<string, unknown>,
    newRow: updated as Record<string, unknown>,
  })

  return { campaign: updated }
}

// ─── Attack Management ──────────────────────────────────────────────

/**
 * Lists a campaign's attacks. Archived attacks are excluded by default
 * (ADR-0019 / issue #106 U6, R6, R10) — this covers both the campaign
 * editor's attack listing (dashboard `GET /:id/attacks`) and the
 * scheduler's task-generation query (`transitionCampaign`'s `running`
 * branch below), so an archived attack is hidden from the editor and
 * never receives newly generated tasks without either caller needing
 * its own filter. Pass `showArchived: true` for callers that need the
 * full graph regardless of archive state (e.g. DAG cycle/dependency-
 * existence validation, where an archived attack can still be a valid
 * dependency target).
 */
export async function listAttacks(
  campaignId: number,
  opts: { showArchived?: boolean | undefined } = {}
) {
  const conditions = [eq(attacks.campaignId, campaignId)]
  if (!opts.showArchived) {
    conditions.push(isNull(attacks.archivedAt))
  }
  return db
    .select()
    .from(attacks)
    .where(and(...conditions))
    .orderBy(attacks.id)
}

/**
 * Paginated variant of `listAttacks` for the Control API. Same shape
 * as the other paginated services (`{ items, total }` via `LIMIT/
 * OFFSET` + `count(*)`). Deterministic order by `attacks.id` ascending.
 * Archived attacks are excluded by default (ADR-0019 / issue #106 U6,
 * R10) — pass `showArchived: true` to include them, matching
 * `listAttacks`'s non-paginated sibling.
 */
export async function listAttacksPaginated(
  campaignId: number,
  opts: { limit: number; offset: number; showArchived?: boolean | undefined }
) {
  const conditions = [eq(attacks.campaignId, campaignId)]
  if (!opts.showArchived) {
    conditions.push(isNull(attacks.archivedAt))
  }
  const whereClause = and(...conditions)
  const [items, countResult] = await Promise.all([
    db
      .select()
      .from(attacks)
      .where(whereClause)
      .orderBy(asc(attacks.id))
      .limit(opts.limit)
      .offset(opts.offset),
    db.select({ value: count() }).from(attacks).where(whereClause),
  ])
  return { items, total: Number(countResult[0]?.value ?? 0) }
}

export async function getAttackById(id: number) {
  const [attack] = await db.select().from(attacks).where(eq(attacks.id, id)).limit(1)
  return attack ?? null
}

export async function createAttack(
  data: {
    campaignId: number
    projectId: number
    mode: number
    hashTypeId?: number | undefined
    wordlistId?: number | undefined
    rulelistId?: number | undefined
    masklistId?: number | undefined
    advancedConfiguration?: Record<string, unknown> | undefined
    dependencies?: number[] | undefined
  },
  actor: AuditActor = {
    actorType: 'system',
    actorId: null,
  }
) {
  const keyspace = await computeAttackKeyspace(data)

  // Insert and audit run in one transaction so a crash between the two
  // cannot leave an attack with no audit record (R4 atomicity).
  const attack = await db.transaction(async (tx) => {
    const [inserted] = await tx
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
        keyspace,
      })
      .returning()

    if (inserted) {
      // Permanence latch (ADR-0019 / issue #106 U3): see latchAttackResources.
      await latchAttackResources(tx, inserted)

      await recordAuditEvent(
        {
          actor,
          projectId: inserted.projectId,
          entityType: 'attack',
          entityId: inserted.id,
          action: 'created',
          newRow: inserted as Record<string, unknown>,
        },
        tx
      )
    }

    return inserted ?? null
  })

  // Keyspace couldn't be computed inline (referenced resource not counted yet):
  // enqueue a count job best-effort so it fills in once the resource is sized.
  // Runs outside the transaction — queue enqueue is a post-commit side effect.
  if (attack && keyspace === null) {
    await enqueueLineCountForUncountedResources({
      wordlistId: attack.wordlistId,
      rulelistId: attack.rulelistId,
      masklistId: attack.masklistId,
      projectId: attack.projectId,
    })
  }

  return attack
}

export async function updateAttack(
  id: number,
  data: {
    mode?: number | undefined
    hashTypeId?: number | undefined
    wordlistId?: number | undefined
    rulelistId?: number | undefined
    masklistId?: number | undefined
    advancedConfiguration?: Record<string, unknown> | undefined
    dependencies?: number[] | undefined
  },
  actor: AuditActor = {
    actorType: 'system',
    actorId: null,
  }
) {
  // Fetch the existing row before opening the transaction so the
  // keyspace recompute (which may do async resource lookups) runs
  // outside the transaction and does not hold locks unnecessarily.
  const [existing] = await db.select().from(attacks).where(eq(attacks.id, id)).limit(1)
  if (!existing) return null

  // Recompute keyspace from the merged inputs so an edit that swaps a
  // wordlist/rulelist/mask refreshes the stored value (it tracks current
  // inputs, including back to null when a new resource isn't counted yet).
  const keyspace = await computeAttackKeyspace({
    mode: data.mode ?? existing.mode,
    wordlistId: data.wordlistId ?? existing.wordlistId,
    rulelistId: data.rulelistId ?? existing.rulelistId,
    masklistId: data.masklistId ?? existing.masklistId,
    advancedConfiguration: data.advancedConfiguration ?? existing.advancedConfiguration,
  })

  // UPDATE and audit run in one transaction so a crash between the two
  // cannot leave an attack update with no audit record (R4 atomicity).
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(attacks)
      .set({ ...data, keyspace, updatedAt: new Date() })
      .where(eq(attacks.id, id))
      .returning()

    if (row) {
      // Permanence latch (ADR-0019 / issue #106 U3): latch whichever
      // resource is in effect AFTER the update (see latchAttackResources) —
      // covers both a fresh reference and a swap to a new resource.
      await latchAttackResources(tx, row)

      await recordAuditEvent(
        {
          actor,
          projectId: row.projectId,
          entityType: 'attack',
          entityId: row.id,
          action: 'updated',
          oldRow: existing as Record<string, unknown>,
          newRow: row as Record<string, unknown>,
        },
        tx
      )
    }

    return row ?? null
  })

  // A resource swap may point at an uncounted wordlist/rulelist: enqueue a
  // count job best-effort so keyspace fills in once the resource is sized.
  // Runs outside the transaction — queue enqueue is a post-commit side effect.
  if (updated && keyspace === null) {
    await enqueueLineCountForUncountedResources({
      wordlistId: updated.wordlistId,
      rulelistId: updated.rulelistId,
      masklistId: updated.masklistId,
      projectId: updated.projectId,
    })
  }

  return updated
}

/**
 * Outcome of an attack delete attempt (issue #106 U6). Mirrors
 * `DeleteCampaignResult` / `DeleteResourceResult`: a purely backend-internal
 * discriminated union — routes translate `kind` into the HTTP envelope, it
 * is never serialized verbatim, so it does not need a shared Zod schema.
 */
export type DeleteAttackResult =
  | { kind: 'not_found' }
  // Latched permanent (has generated at least one task, ever) —
  // archive-only, never hard-deletable again even after the campaign
  // stops or every task is cancelled.
  | { kind: 'not_deletable' }
  | { kind: 'deleted'; id: number; projectId: number }

export async function deleteAttack(
  id: number,
  actor: AuditActor = {
    actorType: 'system',
    actorId: null,
  }
): Promise<DeleteAttackResult> {
  class LatchedDuringDelete extends Error {}

  try {
    return await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(attacks).where(eq(attacks.id, id)).limit(1)
      if (!existing) return { kind: 'not_found' } as const
      if (existing.isPermanent) return { kind: 'not_deletable' } as const

      // Atomic guard: only delete while still non-permanent. A concurrent
      // task-generation run that latched permanence between the pre-check
      // and this statement returns zero rows; throw so the caller (below)
      // reclassifies the race as not_deletable rather than reporting a
      // delete that didn't actually happen.
      const deleted = await tx
        .delete(attacks)
        .where(and(eq(attacks.id, id), eq(attacks.isPermanent, false)))
        .returning()
      const row = deleted[0]
      if (!row) {
        throw new LatchedDuringDelete()
      }

      await recordAuditEvent(
        {
          actor,
          projectId: row.projectId,
          entityType: 'attack',
          entityId: row.id,
          action: 'deleted',
          oldRow: existing as Record<string, unknown>,
        },
        tx
      )

      return { kind: 'deleted', id: row.id, projectId: row.projectId } as const
    })
  } catch (err) {
    if (err instanceof LatchedDuringDelete) {
      return { kind: 'not_deletable' }
    }
    throw err
  }
}
