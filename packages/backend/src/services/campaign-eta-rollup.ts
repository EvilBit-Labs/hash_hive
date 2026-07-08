/**
 * Campaign-level ETA rollup (issue #100 U1): a read-time sum of per-attack
 * `estimateSecondsRemaining` (`services/attacks/complexity.ts`) over a
 * campaign's non-terminal attacks, encoded as the discriminated
 * `CampaignEta` state so every display surface renders the same honesty
 * copy instead of each caller inventing its own "no data" string.
 *
 * Deliberately NOT named `campaign-eta.ts` — that basename belongs to the
 * frontend client-side proxy this feature retires (plan U6). Lives at the
 * top of `services/` rather than `services/attacks/` because the rollup
 * reads `campaigns`/`tasks` state one layer above a single attack, mirroring
 * where `campaign-dashboard.ts` (its sibling `listActiveAgentsByCampaign`)
 * already lives.
 *
 * The batch entry point (`getCampaignEtasBatch`) is the one U2's list view
 * calls: one `attacks` fetch, one `deriveAttackRuntimes` call (which itself
 * batches task aggregates + fleet benchmarks per distinct (projectId, mode)),
 * one campaign-status fetch, and one active-agents fetch — never a
 * per-campaign query cascade for N campaigns on a page.
 */
import {
  type CampaignEta,
  type CampaignStatus,
  agents,
  attacks,
  campaigns,
  tasks,
} from '@hashhive/shared'
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm'

import { db } from '../db/index.js'
import { jsonSafeBigint } from './attacks/_internals.js'
import {
  type AttackRuntime,
  deriveAttackRuntimes,
  isNonTerminalAttackStatus,
} from './attacks/runtime.js'
import { AGENT_TASK_ACTIVE_STATUSES } from './tasks/agent-projection.js'

/**
 * Convert one attack's bigint-safe `number | string` ETA into a bigint so
 * a campaign-wide sum never loses precision the way `Number(...)` would for
 * a mask attack's ETA past `Number.MAX_SAFE_INTEGER` (see `jsonSafeBigint`).
 */
function toBigInt(value: number | string): bigint {
  return BigInt(value)
}

function sumResolved(values: ReadonlyArray<number | string>): bigint {
  return values.reduce((sum, value) => sum + toBigInt(value), 0n)
}

/**
 * The minimal per-attack shape the rollup's precedence ladder needs —
 * structurally identical to `AttackRuntime` (runtime.ts), so derived rather
 * than independently declared to keep the two from drifting apart.
 */
export type AttackEtaInput = Pick<AttackRuntime, 'status' | 'estimatedSecondsRemaining'>

/**
 * Pure precedence ladder — no I/O, so the full state combination space can
 * be unit-tested directly. Mirrors the documented precedence style of
 * `deriveAttackStatus` (runtime.ts):
 *
 * 1. `complete` — zero non-terminal attacks. Evaluated FIRST so an empty
 *    (or fully-terminal) attack set never falls through to a vacuously-true
 *    zero-second `ready` and renders "0h" (R16 / AE7).
 * 2. `paused` — a manual campaign pause overrides throughput entirely; a
 *    sum computed while paused would look live but isn't (R9 / AE3).
 * 3. `no_agents` — nobody is currently working the campaign right now, so
 *    any sum would be a stale projection even if a fleet benchmark exists
 *    for the mode.
 * 4. Otherwise sum the non-terminal attacks' `estimatedSecondsRemaining`
 *    (already R11-guarded — malformed/non-positive agent speeds are
 *    filtered out inside `estimateSecondsRemaining`): every attack resolves
 *    -> `ready`; some resolve and at least one does not -> `lower_bound`;
 *    none resolve -> `estimating`.
 */
export function computeCampaignEtaState(input: {
  campaignStatus: CampaignStatus
  hasActiveAgents: boolean
  attacks: ReadonlyArray<AttackEtaInput>
}): CampaignEta {
  const nonTerminal = input.attacks.filter((attack) => isNonTerminalAttackStatus(attack.status))

  if (nonTerminal.length === 0) return { state: 'complete' }
  // A cancelled campaign's non-terminal attacks will never receive new tasks,
  // so treat it as terminal rather than projecting a live ETA over stopped
  // work (same staleness the `paused` guard prevents; ARCHITECTURE.md lifecycle).
  if (input.campaignStatus === 'cancelled') return { state: 'complete' }
  if (input.campaignStatus === 'paused') return { state: 'paused' }
  if (!input.hasActiveAgents) return { state: 'no_agents' }

  const resolved: Array<number | string> = []
  let pendingAttacks = 0
  for (const attack of nonTerminal) {
    if (attack.estimatedSecondsRemaining === null) {
      pendingAttacks += 1
    } else {
      resolved.push(attack.estimatedSecondsRemaining)
    }
  }

  if (resolved.length === 0) return { state: 'estimating' }

  const seconds = jsonSafeBigint(sumResolved(resolved))
  return pendingAttacks > 0
    ? { state: 'lower_bound', seconds, pendingAttacks }
    : { state: 'ready', seconds }
}

/**
 * Campaign ids that currently have at least one active task claimed by an
 * agent. Mirrors the active-task definition `listActiveAgentsByCampaign`
 * uses (`campaign-dashboard.ts`) — tasks in `pending`/`assigned`/`running`
 * with a non-null `agentId` — but batches the presence check across every
 * requested campaign id in one query instead of one row-fetch per campaign,
 * and drops the per-agent detail the rollup doesn't need.
 */
async function loadCampaignIdsWithActiveAgents(
  campaignIds: ReadonlyArray<number>
): Promise<Set<number>> {
  if (campaignIds.length === 0) return new Set()
  const rows = await db
    .selectDistinct({ campaignId: tasks.campaignId })
    .from(tasks)
    .innerJoin(agents, eq(tasks.agentId, agents.id))
    .where(
      and(
        inArray(tasks.campaignId, [...campaignIds]),
        inArray(tasks.status, [...AGENT_TASK_ACTIVE_STATUSES])
      )
    )
  return new Set(rows.map((row) => row.campaignId))
}

/**
 * Compute the campaign ETA for every id in `campaignIds` in one pass.
 * Returns a state for every requested id, including ids with no attacks at
 * all (vacuously `complete` — never a fabricated number).
 */
export async function getCampaignEtasBatch(
  campaignIds: ReadonlyArray<number>
): Promise<Map<number, CampaignEta>> {
  const result = new Map<number, CampaignEta>()
  const ids = [...new Set(campaignIds)]
  if (ids.length === 0) return result

  // Archived attacks are hidden from the campaign editor / scheduler
  // (schema.ts comment on `attacks.archivedAt`) and excluded from the
  // mode-consistency guard's sibling scan (`checkSingleHashModePerCampaign`)
  // — the ETA rollup must exclude them too (code review fix, issue #100
  // R1), otherwise an archived attack's estimate silently inflates the
  // campaign-wide sum even though it will never receive new tasks.
  const attackRows = await db
    .select({
      id: attacks.id,
      campaignId: attacks.campaignId,
      projectId: attacks.projectId,
      mode: attacks.mode,
      keyspace: attacks.keyspace,
    })
    .from(attacks)
    .where(and(inArray(attacks.campaignId, ids), isNull(attacks.archivedAt)))

  const [runtimeByAttack, campaignRows, activeAgentCampaignIds] = await Promise.all([
    deriveAttackRuntimes(attackRows),
    db
      .select({ id: campaigns.id, status: campaigns.status })
      .from(campaigns)
      .where(inArray(campaigns.id, ids)),
    loadCampaignIdsWithActiveAgents(ids),
  ])
  // `campaigns.status` is a `varchar(20)` column (schema.ts) — Drizzle
  // infers it as `string`, not the narrower `CampaignStatus` literal union.
  // Cast at this boundary (a real corrupt DB value would be a data-layer
  // bug, not something this rollup should silently coerce) so
  // `computeCampaignEtaState`'s signature stays the strict enum type.
  const campaignStatusById = new Map(
    campaignRows.map((row) => [row.id, row.status as CampaignStatus])
  )

  // `attacksByCampaign` is a local accumulator (mirrors the same pattern in
  // `deriveAttackRuntimes`'s own `result`/`aggByAttack` maps): the Map
  // itself is built incrementally, but each per-campaign array is replaced
  // (never pushed-to-in-place) so no caller can observe a partially-built list.
  const attacksByCampaign = new Map<number, AttackEtaInput[]>()
  for (const attack of attackRows) {
    const runtime = runtimeByAttack.get(attack.id)
    const input: AttackEtaInput = {
      status: runtime?.status ?? 'pending',
      estimatedSecondsRemaining: runtime?.estimatedSecondsRemaining ?? null,
    }
    attacksByCampaign.set(attack.campaignId, [
      ...(attacksByCampaign.get(attack.campaignId) ?? []),
      input,
    ])
  }

  for (const id of ids) {
    result.set(
      id,
      computeCampaignEtaState({
        campaignStatus: campaignStatusById.get(id) ?? 'draft',
        hasActiveAgents: activeAgentCampaignIds.has(id),
        attacks: attacksByCampaign.get(id) ?? [],
      })
    )
  }
  return result
}

/** Single-campaign convenience wrapper over the batch entry point. */
export async function getCampaignEta(campaignId: number): Promise<CampaignEta> {
  const results = await getCampaignEtasBatch([campaignId])
  // Unreachable today — `getCampaignEtasBatch` always populates an entry for
  // every requested id, even ids with no attacks at all (vacuous `complete`).
  // Falls back to the neutral "no data yet" state rather than `complete` so
  // a future lookup miss can never misrender a still-running campaign as
  // finished (code review fix).
  return results.get(campaignId) ?? { state: 'estimating' }
}

/**
 * Archived attack ids in `campaignId` (code review fix, issue #100 R1).
 * `getCampaignAttacksWithRuntime` (attacks/runtime.ts), which the campaign-
 * detail route uses to build its `attacks` payload, intentionally returns
 * every attack row regardless of archive state — the detail page's attack
 * table is a separate concern from the ETA rollup. This is a narrow,
 * purpose-built lookup so the detail route can filter archived rows OUT of
 * `computeCampaignEtaState`'s input without changing what the payload's
 * `attacks` array itself contains.
 */
export async function getArchivedAttackIds(campaignId: number): Promise<Set<number>> {
  const rows = await db
    .select({ id: attacks.id })
    .from(attacks)
    .where(and(eq(attacks.campaignId, campaignId), isNotNull(attacks.archivedAt)))
  return new Set(rows.map((row) => row.id))
}
