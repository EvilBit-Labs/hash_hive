/**
 * Super-targeted campaign progress / results / ETA aggregation (issue #101 U11,
 * R12 / R1).
 *
 * A super PARENT campaign carries `superHashListId`, owns no attacks/tasks of
 * its own, and fans out (U10) to one single-mode sub-campaign per typed leaf
 * (linked via `campaigns.parentCampaignId`). So — exactly like a #202 split
 * parent (`services/hash-items/split-progress.ts`) — its progress has to be
 * aggregated on READ from its sub-campaigns; `updateCampaignProgress` never
 * runs for a parent, so the parent row's own `progress`/`attacks` stay empty.
 *
 * The two axes are computed by DELIBERATELY DIFFERENT functions (adversarial
 * F6). A mixed-type super's modes have wildly different keyspaces and crack
 * rates, so treating them uniformly misleads:
 *
 *   (a) **Cracked-count / results — the DEDUPLICATED union.** Rolled up through
 *       the U4 project cracked-set resolver so a value cracked ONCE counts once,
 *       even when it exists as separate `hash_items` rows under two members. A
 *       naive `sum(sub-campaign hashProgress.cracked)` would double-count a
 *       value present in two members; instead we `count(distinct …)` the
 *       resolved-cracked values across the whole union via
 *       {@link crackedSetJoinOn} / {@link RESOLVED_CRACKED_VALUE}. This is the
 *       same dedup-by-`hashValue` instinct `getHashListStats` already applies
 *       across sibling sub-lists, generalized to the super's leaf union.
 *
 *   (b) **Completion / ETA — the CRITICAL PATH (max) over sub-campaigns.** NOT
 *       an average or sum of sub-campaign keyspace progress: a 90 %-done NTLM
 *       sub-campaign plus a 10 %-done sha512crypt sub-campaign is not "50 %" —
 *       wall-clock is bounded by the slowest mode. So the super's ETA is the MAX
 *       of its sub-campaign ETAs ({@link computeSuperCriticalPathEta}). A fast
 *       sub near completion can never drag the super's reported finish earlier
 *       than the slow sub still lags.
 *
 * Out of scope (plan Open Questions): how these rolled-up numbers feed the
 * FLEET-WIDE crack-yield / time-to-first-crack / ETA-accuracy metrics
 * dashboards. This unit defines the aggregation; wiring it to fleet metrics is
 * deliberately left open.
 */
import type { CampaignEta, SubCampaignHashProgress, SuperCampaignProgress } from '@hashhive/shared'

import { campaigns, hashItems, projectCrackedHashes } from '@hashhive/shared'
import { and, eq, inArray, sql } from 'drizzle-orm'

import { db } from '../db/index.js'
import { jsonSafeBigint } from './attacks/_internals.js'
import { getCampaignEtasBatch } from './campaign-eta-rollup.js'
import { crackedSetJoinOn, RESOLVED_IS_CRACKED } from './hash-items/crack-resolution.js'
import { resolveNodeToLeaves } from './hash-items/node-resolution/index.js'

/**
 * Combine sub-campaign ETAs into the super's **critical-path (MAX)** ETA
 * (axis b). Pure — no I/O — so the whole state-combination space is unit
 * testable without seeding a live fleet.
 *
 * A completed sub contributes zero remaining time, so it drops out of the
 * critical path; the super is only `complete` once EVERY sub is complete (or
 * there are no subs at all). Precedence mirrors the single-campaign ladder
 * (`computeCampaignEtaState`): `paused` / `no_agents` on ANY still-active sub
 * dominate, because the slowest work is not currently progressing and a MAX
 * over the rest would understate the true finish (the exact "fast sub makes the
 * super look near-done" failure the plan warns against). Otherwise the result
 * is the MAX resolved seconds across active subs; if any active sub is still
 * `estimating` or is itself a `lower_bound`, the max is reported as a
 * `lower_bound` with the count of not-fully-resolved subs.
 */
export function computeSuperCriticalPathEta(subEtas: readonly CampaignEta[]): CampaignEta {
  if (subEtas.length === 0) return { state: 'complete' }

  // A completed sub has zero remaining time — it never bounds the critical path.
  const active = subEtas.filter((eta) => eta.state !== 'complete')
  if (active.length === 0) return { state: 'complete' }

  // Non-progressing states dominate a MAX: if the potentially-slowest sub is
  // paused or agent-starved, no honest finite finish can be projected for the
  // whole super. Order matches the single-campaign ladder (paused before
  // no_agents).
  if (active.some((eta) => eta.state === 'paused')) return { state: 'paused' }
  if (active.some((eta) => eta.state === 'no_agents')) return { state: 'no_agents' }

  // Critical path = MAX resolved seconds across active subs (bounded by the
  // slowest mode), NOT a sum or average.
  let maxSeconds: bigint | null = null
  let unresolvedSubs = 0
  for (const eta of active) {
    if (eta.state === 'estimating') {
      unresolvedSubs += 1
      continue
    }
    // `paused` / `no_agents` are already handled by the early returns above;
    // this guard is defensive AND narrows `eta` to the seconds-bearing states
    // (`ready` | `lower_bound`) for the type checker.
    if (eta.state === 'paused' || eta.state === 'no_agents') continue
    // `ready` and `lower_bound` both carry `seconds`; a `lower_bound` sub is
    // itself only a floor, so it also makes the super-wide max a floor.
    if (eta.state === 'lower_bound') unresolvedSubs += 1
    const seconds = BigInt(eta.seconds)
    if (maxSeconds === null || seconds > maxSeconds) maxSeconds = seconds
  }

  // Nothing resolved to a number yet — every active sub is still estimating.
  if (maxSeconds === null) return { state: 'estimating' }

  // `campaignEtaSchema.lower_bound.pendingAttacks` is documented (index.ts) as
  // "unresolved attacks within a campaign" for the single-campaign case. Here
  // it is DELIBERATELY reused to count unresolved SUB-CAMPAIGNS instead - a
  // super parent has no attacks of its own, so there is no other honest count
  // to report, and adding a super-specific field would fork the schema/UI for
  // one caller. Callers rendering a super's eta must read `pendingAttacks` as
  // "N sub-campaigns still estimating/lower_bound", not "N attacks".
  return unresolvedSubs > 0
    ? { state: 'lower_bound', seconds: jsonSafeBigint(maxSeconds), pendingAttacks: unresolvedSubs }
    : { state: 'ready', seconds: jsonSafeBigint(maxSeconds) }
}

/**
 * Derive `SuperCampaignProgress.done` so it never contradicts `eta`. A super
 * with zero sub-campaigns has nothing left to run, and
 * `computeSuperCriticalPathEta([])` reports it `complete` - `done` must agree
 * with that, or a client sees `eta.state === 'complete'` alongside
 * `done: false` for the same payload. For a non-empty sub-campaign set,
 * `done` still requires every sub to have reached `completed` status
 * (matching `eta`'s own "every sub complete -> complete" rule).
 *
 * Pure - no I/O - so the zero-sub-campaign case is unit testable without
 * seeding a live fleet.
 */
export function deriveSuperDone(
  subCampaignCount: number,
  completedSubCampaignCount: number,
  eta: CampaignEta
): boolean {
  return subCampaignCount === 0
    ? eta.state === 'complete'
    : completedSubCampaignCount === subCampaignCount
}

/**
 * Deduplicated cracked-count / results over a super's leaf union (axis a).
 *
 * One aggregate query over every leaf's `hash_items`, LEFT-JOINed to the
 * project cracked-set on the SAME key the U4 resolver uses
 * (`(projectId, detectedHashcatMode, hashValue)`), so:
 *   - `total` is the raw union row count (mirrors `getHashListStats.totalCount`
 *     — never deduped), and
 *   - `cracked` is `count(distinct …)` of the resolved-cracked `(mode, value)`
 *     composite, so a value cracked once — in its own member OR cross-list in a
 *     sibling — counts exactly once (the double-count concern R12 names). The
 *     dedup key is `(coalesce(detectedHashcatMode, -1), hashValue)`, NOT
 *     `hashValue` alone: a super's leaf union is deliberately mixed-mode, so a
 *     32-hex value cracked as raw-MD5 in one member and NTLM in another (AE1) is
 *     TWO distinct cracks and must count as two — matching the `(mode, value)`
 *     dedup the U14 super export uses (`SUPER_COALESCED_MODE_SQL`), so progress
 *     and export of the same super never disagree.
 *
 * Returns `null` when the union has no items yet (parity with the leaf
 * `hashProgress` field, which `updateCampaignProgress` only writes when
 * `total > 0`).
 */
async function computeDedupedUnionHashProgress(
  leafIds: readonly number[],
  projectId: number
): Promise<SubCampaignHashProgress | null> {
  if (leafIds.length === 0) return null

  const [row] = await db
    .select({
      total: sql<number>`count(*)`.mapWith(Number),
      cracked:
        sql<number>`count(distinct case when ${RESOLVED_IS_CRACKED} then coalesce(${hashItems.detectedHashcatMode}, -1)::text || ':' || ${hashItems.hashValue} end)`.mapWith(
          Number
        ),
    })
    .from(hashItems)
    .leftJoin(projectCrackedHashes, crackedSetJoinOn(projectId))
    .where(inArray(hashItems.hashListId, [...leafIds]))

  const total = row?.total ?? 0
  if (total === 0) return null
  const cracked = row?.cracked ?? 0
  return {
    total,
    // Clamp so a transient inconsistency can never produce a negative remaining.
    cracked,
    remaining: Math.max(0, total - cracked),
    percentage: total > 0 ? cracked / total : 0,
  }
}

/**
 * Aggregate progress/results/ETA for a super PARENT campaign, computed at read
 * time from its sub-campaigns and the deduplicated leaf union.
 *
 * Sub-campaigns are found via THIS parent's id
 * (`campaigns.parentCampaignId = parentCampaignId`), never by "hashListId is one
 * of the leaves" — an unrelated campaign a user created directly against a leaf
 * list (with no `parentCampaignId`) must not pollute the super's aggregate,
 * exactly as `getHashListSplitProgress` guards for #202.
 *
 * @param parentCampaignId The super PARENT campaign's id (the one carrying
 *                         `superHashListId`, `parentCampaignId IS NULL`).
 * @param superHashListId  The super this parent targets — resolved to its typed
 *                         leaf union for the deduped cracked-count.
 * @param projectId        Project scope (IDOR guard on both the sub-campaign and
 *                         the leaf-union reads).
 */
export async function getSuperCampaignProgress(input: {
  parentCampaignId: number
  superHashListId: number
  projectId: number
}): Promise<SuperCampaignProgress> {
  // The sub-campaign rows (keyed on parentCampaignId) and the leaf union
  // (keyed on superHashListId) are independent reads — issue them together.
  const [subCampaignRows, leafIds] = await Promise.all([
    db
      .select({ id: campaigns.id, status: campaigns.status })
      .from(campaigns)
      .where(
        and(
          eq(campaigns.parentCampaignId, input.parentCampaignId),
          eq(campaigns.projectId, input.projectId)
        )
      ),
    resolveNodeToLeaves({
      kind: 'super',
      superHashListId: input.superHashListId,
      projectId: input.projectId,
    }),
  ])

  const subCampaignCount = subCampaignRows.length
  const completedSubCampaignCount = subCampaignRows.filter(
    (row) => row.status === 'completed'
  ).length

  // (a) Deduped cracked-count / results over the leaf union (via the U4 resolver)
  // and (b) critical-path MAX ETA over sub-campaigns — issued together.
  const [hashProgress, etaByCampaign] = await Promise.all([
    computeDedupedUnionHashProgress(leafIds, input.projectId),
    getCampaignEtasBatch(subCampaignRows.map((row) => row.id)),
  ])

  const subEtas = subCampaignRows.map(
    // A batch miss falls back to the neutral "no data yet" state rather than
    // `complete`, so a lookup gap can never render a running super as finished
    // (mirrors `getCampaignEta`'s own fallback).
    (row): CampaignEta => etaByCampaign.get(row.id) ?? { state: 'estimating' }
  )
  const eta = computeSuperCriticalPathEta(subEtas)
  const done = deriveSuperDone(subCampaignCount, completedSubCampaignCount, eta)

  return { subCampaignCount, completedSubCampaignCount, done, hashProgress, eta }
}
