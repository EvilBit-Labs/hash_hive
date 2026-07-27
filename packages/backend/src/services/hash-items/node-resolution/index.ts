/**
 * Node-resolution layer (plan U5 / KTD7) — the single reusable seam that
 * resolves a NODE to its typed leaf hash lists and groups the union of their
 * items by resolved hashcat mode.
 *
 * A "node" is anything a campaign can fan out over:
 *   - a #202 split PARENT hash list — its typed leaves are its
 *     `parent_hash_list_id` children (one level), and
 *   - (U10, not yet) a SUPER hash list — its leaves are its members, each
 *     resolved one FURTHER level so a member that is itself a #202 split
 *     parent expands to its physical per-mode children.
 *
 * This unit (U5) implements the #202-parent case and the shared grouping
 * primitives, and leaves a typed extension point for the super case that
 * U10 fills once the `super_hash_lists` tables exist (they do not yet).
 *
 * Barrel-plus-subdir layout (`docs/solutions/conventions/barrel-plus-subdir-service-split.md`):
 *   - This barrel owns the DB-touching resolution (`resolveNodeToLeaves`)
 *     and re-exports the pure grouping helpers from `./_internals.js`, so a
 *     consumer can pull the whole layer from this one path.
 *   - The pure grouping helpers live in `./_internals.js` (db-free) so a
 *     caller that only needs grouping — e.g. the split worker, or a unit
 *     test — imports them WITHOUT loading the Postgres client this file
 *     needs, and no ESM cycle forms.
 */

import { hashLists } from '@hashhive/shared'
import { and, eq } from 'drizzle-orm'

import { db } from '../../../db/index.js'

// ─── Re-exports: pure grouping primitives (shared with the #202 worker & U10) ──
export {
  compareSplitGroups,
  degenerateOutcomeFor,
  GROUP_KIND_ORDER,
  groupItemsByMode,
  mergeChunkGroups,
  type NodeGrouping,
  splitGroupKey,
} from './_internals.js'

// ─── Node descriptor ────────────────────────────────────────────────────────

/**
 * Describes the NODE a campaign fans out over. Discriminated on `kind` so
 * the super case (U10) is a purely additive new variant — the type is the
 * extension point.
 *
 * U5 defines exactly one variant, the #202 split parent. U10 will add:
 *
 * ```ts
 *   | { kind: 'super'; superHashListId: number; projectId: number }
 * ```
 *
 * and a matching `case 'super':` in `resolveNodeToLeaves` that resolves the
 * super's members and expands each one FURTHER level (a #202-parent member →
 * its children). Nothing about the #202 path below has to change for that —
 * that is the whole point of routing #202 through this seam now.
 */
export type NodeDescriptor = {
  /** A #202 split PARENT hash list — a list that has been partitioned into
   * per-type children via `hash_lists.parent_hash_list_id`. */
  kind: 'split-parent'
  hashListId: number
  projectId: number
}

/**
 * Injectable DB seam so `resolveNodeToLeaves` is unit-testable without a
 * live Postgres connection (mirrors `_campaignSplitDeps` in
 * `services/campaign-split.ts`). Production uses the default that queries
 * the shared pooled `db`; tests override `fetchSplitParentLeaves`.
 */
export const _nodeResolutionDeps = {
  fetchSplitParentLeaves: defaultFetchSplitParentLeaves,
}

/**
 * Resolves a #202 split parent to its typed child leaf `hash_list.id`s.
 *
 * Mirrors `resolveHashListScope`'s (`services/hash-items/list-scope.ts`)
 * one-level, project-scoped expansion, but returns the CHILDREN ONLY — not
 * the parent id. A split parent's own `hash_items` are moved to its children
 * at split time, so the parent is an empty shell; the typed leaves are the
 * children. The `project_id = $2` predicate is the IDOR guard: a parent id
 * from another project (or a nonexistent id) resolves to `[]`.
 *
 * One level only: a child's own children (grandchildren) are never walked —
 * the #202 split design produces exactly one level of sub-lists.
 */
async function defaultFetchSplitParentLeaves(
  hashListId: number,
  projectId: number
): Promise<number[]> {
  const rows = await db
    .select({ id: hashLists.id })
    .from(hashLists)
    .where(and(eq(hashLists.parentHashListId, hashListId), eq(hashLists.projectId, projectId)))
  return rows.map((r) => r.id)
}

/**
 * Resolves a node to its typed leaf hash-list ids — the set a caller reads
 * `hash_items` from and groups (via `groupItemsByMode`) to fan out one typed
 * sub-campaign per mode.
 *
 * U5: only the `split-parent` variant. When the super variant lands (U10),
 * add its `case` here; every existing caller keeps working unchanged.
 */
export async function resolveNodeToLeaves(node: NodeDescriptor): Promise<number[]> {
  switch (node.kind) {
    case 'split-parent':
      return _nodeResolutionDeps.fetchSplitParentLeaves(node.hashListId, node.projectId)
    default: {
      // Exhaustiveness guard: when U10 adds the `super` variant to
      // `NodeDescriptor`, this line stops type-checking until a matching
      // `case 'super':` is added above — a compile-time nudge, not a runtime
      // landmine (unreachable for every valid `NodeDescriptor` today).
      const exhaustiveCheck: never = node.kind
      throw new Error(`resolveNodeToLeaves: unhandled node kind ${String(exhaustiveCheck)}`)
    }
  }
}
