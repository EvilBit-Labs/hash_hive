/**
 * Shared "group union items by resolved hashcat mode" helpers for the
 * node-resolution layer (plan U5 / KTD7).
 *
 * These are the pure grouping primitives that both the #202 auto-classify
 * split worker (`queue/workers/hash-list-split.ts`) and — later — the super
 * fan-out (U10, `services/campaign-split.ts` / super services) consume to
 * turn a node's leaf items into one partition per resolved hashcat mode.
 * They were previously PRIVATE duplicates inside `hash-list-split.ts`
 * (`splitGroupKey`, `SPLIT_GROUP_KIND_ORDER`, `compareSplitGroups`,
 * `mergeChunkGroups`, `degenerateOutcomeFor`); U5 lifts them here so the
 * super path reuses the same, provably-identical logic rather than
 * re-duplicating it a third time.
 *
 * This file lives at `node-resolution/_internals.ts` (barrel-plus-subdir
 * convention, `docs/solutions/conventions/barrel-plus-subdir-service-split.md`):
 *   - It imports ONLY the pure classifier (`../split-analysis.js`) — no DB,
 *     no `db/index.js`. Keeping it db-free is what lets a consumer (the
 *     split worker, or a unit test) import these grouping helpers WITHOUT
 *     dragging in the Postgres client that `node-resolution/index.ts`'s
 *     `resolveNodeToLeaves` needs — and avoids the ESM cycle that would form
 *     if a consumer reached these through the barrel while the barrel
 *     re-exports from here.
 *   - The barrel (`./index.ts`) re-exports everything here, so external
 *     callers (U10) can still import the whole layer from one path.
 *
 * The grouping semantics are pinned by `split-analysis.ts`'s cross-unit
 * contract — see that file. In particular: groups are ordered confident
 * (by mode asc), then ambiguous (by signature asc), then unidentified; a
 * sole CONFIDENT group is the only `single-group` degenerate outcome.
 */

import type { SplitDegenerateReason, SplitGroup, SplitItem } from '../split-analysis.js'

import { planSplit } from '../split-analysis.js'

/** Exactly one group after partitioning means there is nothing to split. */
const SINGLE_GROUP_COUNT = 1

/**
 * Stable merge/dedup key for a `SplitGroup`. Mirrors `split-analysis.ts`'s
 * private `groupKey` (that module has no DB dependency and stays that way,
 * so its `groupKey` is not exported); this is the shared copy the grouping
 * primitives below key off.
 */
export function splitGroupKey(group: SplitGroup): string {
  if (group.kind === 'confident') return `confident:${group.mode}`
  if (group.kind === 'ambiguous') return `ambiguous:${group.candidateModes.join(',')}`
  return 'unidentified'
}

/** Deterministic group ordering: confident, then ambiguous, then unidentified. */
export const GROUP_KIND_ORDER: Record<SplitGroup['kind'], number> = {
  confident: 0,
  ambiguous: 1,
  unidentified: 2,
}

/**
 * Deterministic sub-list/sub-campaign creation order — confident (by mode
 * asc), then ambiguous (by candidate-mode signature asc), then unidentified.
 * Mirrors `split-analysis.ts`'s private `compareGroups`.
 */
export function compareSplitGroups(a: SplitGroup, b: SplitGroup): number {
  const kindDiff = GROUP_KIND_ORDER[a.kind] - GROUP_KIND_ORDER[b.kind]
  if (kindDiff !== 0) return kindDiff

  if (a.kind === 'confident' && b.kind === 'confident') {
    return a.mode - b.mode
  }

  if (a.kind === 'ambiguous' && b.kind === 'ambiguous') {
    const maxLen = Math.max(a.candidateModes.length, b.candidateModes.length)
    for (let i = 0; i < maxLen; i++) {
      const diff = (a.candidateModes[i] ?? 0) - (b.candidateModes[i] ?? 0)
      if (diff !== 0) return diff
    }
    return 0
  }

  return 0
}

/**
 * Merges one chunk's `planSplit` groups into a running accumulator,
 * MUTATING `merged` in place. Used by the split worker to fold together the
 * per-chunk `planSplit` results of a keyset-paged large parent without ever
 * materializing the whole item set at once. This is a deliberate exception
 * to the project's immutable-update convention: `merged` is a caller-local
 * accumulator (never shared, never read mid-loop), and rebuilding a fresh
 * `itemIds` array per chunk (`[...existing, ...new]`) would make merging
 * O(total items accumulated) per chunk — quadratic in chunk count, defeating
 * the memory bound the chunking exists for.
 *
 * Safe to concat without a cross-chunk `hashValue` re-dedup: `(hash_list_id,
 * hash_value)` is unique at the DB level (ingestion's `onConflictDoNothing`,
 * per `split-analysis.ts`'s cross-unit contract), so the same `hashValue`
 * can never appear in two chunks of the same parent. Within a SINGLE chunk,
 * `planSplit` already deduped identical values inside a destination group.
 */
export function mergeChunkGroups(
  merged: Map<string, SplitGroup>,
  chunkGroups: readonly SplitGroup[]
): void {
  for (const group of chunkGroups) {
    const key = splitGroupKey(group)
    const existing = merged.get(key)
    if (!existing) {
      merged.set(key, { ...group, itemIds: [...group.itemIds] })
      continue
    }
    existing.itemIds.push(...group.itemIds)
  }
}

/**
 * Computes `planSplit`'s degenerate-outcome rule over an ALREADY-MERGED
 * (whole-union) partition — a keyed group map plus its total item count,
 * rather than a single `planSplit` call's output. Used by the split worker
 * over the cross-chunk merged map, and available to any node-level caller
 * that assembled its union incrementally.
 *
 * Mirrors `planSplit`'s own rule exactly (see `split-analysis.ts`): an empty
 * union is `empty`; a union that collapses to exactly ONE group is
 * `single-group` ONLY when that group is CONFIDENT (a genuine single hashcat
 * mode with nothing left to resolve). A sole AMBIGUOUS or UNIDENTIFIED group
 * is NOT degenerate — those hashes are not resolved to a mode yet and must
 * still go through the split/review path.
 */
export function degenerateOutcomeFor(partition: {
  totalCount: number
  groups: ReadonlyMap<string, SplitGroup>
}): SplitDegenerateReason {
  if (partition.totalCount === 0) return 'empty'
  if (partition.groups.size === SINGLE_GROUP_COUNT) {
    const [soleGroup] = partition.groups.values()
    if (soleGroup?.kind === 'confident') return 'single-group'
  }
  return null
}

/** Ordered grouping of a node's leaf-item union by resolved hashcat mode. */
export interface NodeGrouping {
  /** One partition per resolved mode / ambiguous signature / unidentified,
   * ordered by `compareSplitGroups` (confident, ambiguous, unidentified). */
  groups: SplitGroup[]
  /** The same `degenerate` signal `planSplit` returns. */
  degenerate: SplitDegenerateReason
}

/**
 * Groups the UNION of a node's resolved leaf items by hashcat mode — the
 * node-level grouping entry point the plan's KTD7 diagram labels "group union
 * items by resolved hashcat mode (planSplit)". A thin, single-shot wrapper
 * over the pure `planSplit` classifier: it takes the already-gathered union
 * (the caller resolves leaves via `resolveNodeToLeaves` and reads their
 * items) and returns ordered groups + the degenerate signal.
 *
 * The #202 split WORKER does not call this — it keyset-pages a potentially
 * huge parent and folds chunks with `mergeChunkGroups` + `degenerateOutcomeFor`
 * for memory reasons — but both paths share the identical grouping semantics
 * (`planSplit` under the hood). U10's super fan-out, whose unions are the
 * member leaves' items, uses this single-shot form.
 */
export function groupItemsByMode(items: readonly SplitItem[]): NodeGrouping {
  const plan = planSplit(items)
  return { groups: plan.groups, degenerate: plan.degenerate }
}
