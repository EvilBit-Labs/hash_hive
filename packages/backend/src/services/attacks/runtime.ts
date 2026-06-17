/**
 * Read-time attack runtime: status and progressive ETA, derived from task
 * aggregates + the parent campaign's status. Attack status is NOT persisted
 * (issue #99) — a stored column would race campaign auto-completion and drift
 * against a column nothing queries. Both consumers (the dashboard campaign
 * detail payload and the Control attack endpoint) derive through here so the
 * status ladder lives in exactly one place.
 *
 * Lives in services/attacks/ (not campaign-dashboard.ts) so importing
 * `getFleetBenchmarksForMode` from services/tasks.ts does not close a
 * tasks -> campaigns -> campaign-dashboard -> runtime cycle.
 */

import {
  type AttackStatus,
  type CampaignAttackRow,
  type ResourceStatus,
  agentBenchmarks,
  agents,
  attacks,
  campaigns,
  maskLists,
  ruleLists,
  tasks,
  wordLists,
} from '@hashhive/shared'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'

import { db } from '../../db/index.js'
import { estimateSecondsRemaining } from './complexity.js'
import { isKeyspacePending } from './keyspace-pending.js'

/**
 * Fleet benchmark speeds for a (project, mode) — the parallel throughput the
 * ETA divides remaining keyspace by. Inlined here rather than imported from
 * services/tasks.ts on purpose: importing that module pulls the whole
 * tasks -> campaigns service graph into every runtime consumer (the dashboard
 * and Control attack routes), which both closes an import cycle and breaks
 * those routes' partial `mock.module('campaigns.js')` tests at link time.
 * Mirrors `getFleetBenchmarksForMode` in services/tasks.ts — keep the agent
 * status filter ('online','benchmarked','busy') in sync.
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

/** Per-attack task-status tallies the ladder reasons over. */
export interface AttackStatusCounts {
  total: number
  pending: number
  running: number
  assigned: number
  paused: number
  failed: number
}

/** Derived read-time runtime for one attack. */
export interface AttackRuntime {
  status: AttackStatus
  estimatedSecondsRemaining: number | string | null
}

/**
 * Map an attack's task tallies + its campaign status onto the attack status.
 * Pure (no I/O) so the full ladder can be unit-tested over the count
 * combinations. Precedence: a manual campaign pause overrides everything; then
 * live work (running/assigned, or pending mixed with progress) outranks paused
 * work; only when no live work remains does the terminal split apply.
 */
export function deriveAttackStatus(
  counts: AttackStatusCounts,
  campaignStatus: string
): AttackStatus {
  // Manual campaign pause sets no task-level status, so read it directly.
  if (campaignStatus === 'paused') return 'paused'
  if (counts.total === 0) return 'pending'
  if (counts.running + counts.assigned > 0) return 'running'
  if (counts.pending > 0) return counts.pending === counts.total ? 'pending' : 'running'
  // No pending and no running/assigned: every task is terminal or paused.
  if (counts.paused > 0) return 'paused' // #97 preemption transient under a running campaign
  if (counts.failed > 0) return 'failed'
  // All tasks reached a terminal-success state. `completed` only when the
  // campaign completed (a crack landed somewhere); otherwise the attack
  // exhausted its keyspace with no crack here.
  return campaignStatus === 'completed' ? 'completed' : 'exhausted'
}

/** covered-keyspace / total-keyspace, clamped to [0, 1]. */
function computeFractionDone(covered: string, keyspace: string | null): number {
  if (keyspace === null) return 0
  const total = Number(keyspace)
  if (!Number.isFinite(total) || total <= 0) return 0
  const done = Number(covered)
  if (!Number.isFinite(done) || done <= 0) return 0
  return Math.min(done / total, 1)
}

const benchKey = (projectId: number, mode: number): string => `${projectId}:${mode}`

/**
 * Derive status + ETA for a set of attacks. One grouped task aggregate (counts
 * + covered keyspace), one campaign-status lookup, and one fleet-benchmark
 * query per distinct (projectId, mode) — no per-attack N+1. Attacks with no
 * task rows derive cleanly to `pending` with the a-priori ETA.
 */
export async function deriveAttackRuntimes(
  attackList: ReadonlyArray<{
    id: number
    campaignId: number
    projectId: number
    mode: number
    keyspace: string | null
  }>
): Promise<Map<number, AttackRuntime>> {
  const result = new Map<number, AttackRuntime>()
  if (attackList.length === 0) return result

  const attackIds = attackList.map((a) => a.id)

  // Grouped task aggregate: per-status counts for the ladder + covered keyspace
  // for the ETA. Each task's reported progress is clamped to its own chunk
  // total (LEAST) so an overrun cannot inflate coverage; ::numeric keeps mask
  // keyspaces past 2^53 exact, ::text returns a decimal string.
  const aggRows = await db
    .select({
      attackId: tasks.attackId,
      total: sql<number>`count(*)::int`,
      pending: sql<number>`count(*) FILTER (WHERE ${tasks.status} = 'pending')::int`,
      running: sql<number>`count(*) FILTER (WHERE ${tasks.status} = 'running')::int`,
      assigned: sql<number>`count(*) FILTER (WHERE ${tasks.status} = 'assigned')::int`,
      paused: sql<number>`count(*) FILTER (WHERE ${tasks.status} = 'paused')::int`,
      failed: sql<number>`count(*) FILTER (WHERE ${tasks.status} = 'failed')::int`,
      covered: sql<string>`COALESCE(SUM(LEAST(
        COALESCE((${tasks.progress}->>'keyspaceProgress')::numeric, 0),
        COALESCE((${tasks.workRange}->>'total')::numeric, 0)
      )), 0)::text`,
    })
    .from(tasks)
    .where(inArray(tasks.attackId, attackIds))
    .groupBy(tasks.attackId)
  const aggByAttack = new Map(aggRows.map((r) => [r.attackId, r]))

  const campaignIds = [...new Set(attackList.map((a) => a.campaignId))]
  const campaignRows = await db
    .select({ id: campaigns.id, status: campaigns.status })
    .from(campaigns)
    .where(inArray(campaigns.id, campaignIds))
  const statusByCampaign = new Map(campaignRows.map((r) => [r.id, r.status]))

  const distinctPairs = new Map<string, { projectId: number; mode: number }>()
  for (const a of attackList)
    distinctPairs.set(benchKey(a.projectId, a.mode), { projectId: a.projectId, mode: a.mode })
  const benchmarksByPair = new Map<string, { speedHs: number }[]>()
  await Promise.all(
    [...distinctPairs.values()].map(async ({ projectId, mode }) => {
      benchmarksByPair.set(
        benchKey(projectId, mode),
        await getFleetBenchmarksForMode(projectId, mode)
      )
    })
  )

  for (const a of attackList) {
    const agg = aggByAttack.get(a.id)
    const counts: AttackStatusCounts = {
      total: agg?.total ?? 0,
      pending: agg?.pending ?? 0,
      running: agg?.running ?? 0,
      assigned: agg?.assigned ?? 0,
      paused: agg?.paused ?? 0,
      failed: agg?.failed ?? 0,
    }
    const campaignStatus = statusByCampaign.get(a.campaignId) ?? 'draft'
    const fractionDone = computeFractionDone(agg?.covered ?? '0', a.keyspace)
    result.set(a.id, {
      status: deriveAttackStatus(counts, campaignStatus),
      estimatedSecondsRemaining: estimateSecondsRemaining({
        keyspace: a.keyspace,
        fractionDone,
        benchmarks: benchmarksByPair.get(benchKey(a.projectId, a.mode)) ?? [],
      }),
    })
  }
  return result
}

/**
 * Per-attack referenced resource ids — the inputs whose settling state gates the
 * keyspacePending signal (issue #230).
 */
interface AttackResourceRefs {
  wordlistId: number | null
  rulelistId: number | null
  masklistId: number | null
}

/**
 * Batch-load the `status` of every referenced wordlist / rulelist / masklist for
 * a set of attacks — one query per resource table over the distinct referenced
 * ids, never an N+1 per attack. Returns a status lookup keyed by resource kind.
 */
async function loadResourceStatuses(rows: ReadonlyArray<AttackResourceRefs>): Promise<{
  wordlist: Map<number, ResourceStatus>
  rulelist: Map<number, ResourceStatus>
  masklist: Map<number, ResourceStatus>
}> {
  const distinct = (ids: ReadonlyArray<number | null>): number[] => [
    ...new Set(ids.filter((id): id is number => id !== null)),
  ]
  const wordlistIds = distinct(rows.map((r) => r.wordlistId))
  const rulelistIds = distinct(rows.map((r) => r.rulelistId))
  const masklistIds = distinct(rows.map((r) => r.masklistId))

  const toMap = (results: ReadonlyArray<{ id: number; status: ResourceStatus }>) =>
    new Map(results.map((r) => [r.id, r.status]))

  const [wordlist, rulelist, masklist] = await Promise.all([
    wordlistIds.length === 0
      ? []
      : db
          .select({ id: wordLists.id, status: wordLists.status })
          .from(wordLists)
          .where(inArray(wordLists.id, wordlistIds)),
    rulelistIds.length === 0
      ? []
      : db
          .select({ id: ruleLists.id, status: ruleLists.status })
          .from(ruleLists)
          .where(inArray(ruleLists.id, rulelistIds)),
    masklistIds.length === 0
      ? []
      : db
          .select({ id: maskLists.id, status: maskLists.status })
          .from(maskLists)
          .where(inArray(maskLists.id, masklistIds)),
  ])

  return { wordlist: toMap(wordlist), rulelist: toMap(rulelist), masklist: toMap(masklist) }
}

/**
 * Build the campaign-detail attack rows: persisted fields plus derived status
 * and ETA. Replaces the plain `listAttacks(id)` the detail payload used, which
 * surfaced the dead `pending` column. One aggregate, no N+1.
 */
export async function getCampaignAttacksWithRuntime(
  campaignId: number
): Promise<CampaignAttackRow[]> {
  const rows = await db
    .select({
      id: attacks.id,
      campaignId: attacks.campaignId,
      projectId: attacks.projectId,
      mode: attacks.mode,
      keyspace: attacks.keyspace,
      wordlistId: attacks.wordlistId,
      rulelistId: attacks.rulelistId,
      masklistId: attacks.masklistId,
      dependencies: attacks.dependencies,
    })
    .from(attacks)
    .where(eq(attacks.campaignId, campaignId))
    .orderBy(asc(attacks.id))

  const [runtime, resourceStatuses] = await Promise.all([
    deriveAttackRuntimes(rows),
    loadResourceStatuses(rows),
  ])

  // A referenced id that resolves to no row is treated as not-settling
  // (conservative: prefer "--" over a false "Computing...").
  const statusFor = (id: number | null, m: Map<number, ResourceStatus>): ResourceStatus | null =>
    id === null ? null : (m.get(id) ?? null)

  return rows.map((r) => {
    const rt = runtime.get(r.id)
    const keyspacePending = isKeyspacePending({
      mode: r.mode,
      keyspace: r.keyspace,
      wordlistStatus: statusFor(r.wordlistId, resourceStatuses.wordlist),
      rulelistStatus: statusFor(r.rulelistId, resourceStatuses.rulelist),
      masklistStatus: statusFor(r.masklistId, resourceStatuses.masklist),
    })
    return {
      id: r.id,
      campaignId: r.campaignId,
      mode: r.mode,
      status: rt?.status ?? 'pending',
      keyspace: r.keyspace,
      keyspacePending,
      estimatedSecondsRemaining: rt?.estimatedSecondsRemaining ?? null,
      wordlistId: r.wordlistId,
      rulelistId: r.rulelistId,
      masklistId: r.masklistId,
      dependencies: r.dependencies,
    }
  })
}
