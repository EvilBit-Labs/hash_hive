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

import { hashLists, superHashListMembers, superHashLists } from '@hashhive/shared'
import { and, eq, inArray } from 'drizzle-orm'

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
 *   - `split-parent` (U5): a #202 split PARENT hash list.
 *   - `super` (U10): a SuperHashlist — its leaves are its members, each
 *     resolved one FURTHER level so a member that is itself a #202 split
 *     parent expands to its physical per-mode children.
 */
export type NodeDescriptor =
  | {
      /** A #202 split PARENT hash list — a list that has been partitioned into
       * per-type children via `hash_lists.parent_hash_list_id`. */
      kind: 'split-parent'
      hashListId: number
      projectId: number
    }
  | {
      /** A SuperHashlist (KTD5) — a read-time union over its member hash
       * lists. Its typed leaves are the members, each expanded one further
       * level (a #202-parent member → its physical children). */
      kind: 'super'
      superHashListId: number
      projectId: number
    }

/**
 * Injectable DB seam so `resolveNodeToLeaves` is unit-testable without a
 * live Postgres connection (mirrors `_campaignSplitDeps` in
 * `services/campaign-split.ts`). Production uses the default that queries
 * the shared pooled `db`; tests override the fetchers.
 */
export const _nodeResolutionDeps = {
  fetchSplitParentLeaves: defaultFetchSplitParentLeaves,
  fetchSuperMemberLeaves: defaultFetchSuperMemberLeaves,
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
 * Resolves a SuperHashlist to its typed leaf `hash_list.id`s (U10 / KTD6a).
 *
 * A super's leaves are its members expanded ONE FURTHER LEVEL than a
 * split-parent: for each member hash list, if that member is itself a #202
 * split parent (i.e. other lists reference it via `parent_hash_list_id`), its
 * physical per-type children are the leaves; otherwise the homogeneous member
 * IS its own leaf. This is the "resolve each member one more level" rule the
 * KTD6a diagram labels — a member that is a #202 parent → its children.
 *
 * The per-mode union is deliberately NOT materialized (Approach B rejected):
 * the caller fans out one sub-campaign per leaf returned here, and cross-member
 * `(mode, value)` duplicates collapse at run time via Layer one's project-wide
 * zap dedup (U3). Every id returned is a physical list a campaign can target,
 * so tasks and zaps still resolve to one leaf `hashListId` (agent hot path
 * unchanged).
 *
 * Project-scoped throughout (the `super_hash_lists.project_id = $2` join and
 * the children query's `project_id = $2` predicate are the IDOR guards): a
 * super id from another project — or a nonexistent id — resolves to `[]`.
 * Order is deterministic (members by `member_hash_list_id` asc, each member's
 * children by id asc) so repeated resolutions produce a stable leaf sequence.
 */
async function defaultFetchSuperMemberLeaves(
  superHashListId: number,
  projectId: number
): Promise<number[]> {
  const memberRows = await db
    .select({ memberHashListId: superHashListMembers.memberHashListId })
    .from(superHashListMembers)
    .innerJoin(superHashLists, eq(superHashListMembers.superHashListId, superHashLists.id))
    .where(
      and(
        eq(superHashListMembers.superHashListId, superHashListId),
        eq(superHashLists.projectId, projectId)
      )
    )
    .orderBy(superHashListMembers.memberHashListId)
  const memberIds = memberRows.map((r) => r.memberHashListId)
  if (memberIds.length === 0) return []

  // Expand each member one further level: a member that is a #202 split parent
  // contributes its physical children as leaves instead of itself.
  const childRows = await db
    .select({ id: hashLists.id, parentHashListId: hashLists.parentHashListId })
    .from(hashLists)
    .where(and(inArray(hashLists.parentHashListId, memberIds), eq(hashLists.projectId, projectId)))
  const childrenByParent = new Map<number, number[]>()
  for (const child of childRows) {
    if (child.parentHashListId === null) continue
    const bucket = childrenByParent.get(child.parentHashListId)
    if (bucket) {
      bucket.push(child.id)
    } else {
      childrenByParent.set(child.parentHashListId, [child.id])
    }
  }

  const leaves: number[] = []
  // Dedup while preserving first-seen order: a pathological membership can name
  // BOTH a #202 split parent AND one of its physical children as separate
  // members, which would otherwise surface that child leaf twice — double-fanning
  // its sub-campaign (U10) and double-counting it in progress/export. A `Set`
  // collapses it to one deterministic leaf.
  const seen = new Set<number>()
  const push = (id: number): void => {
    if (!seen.has(id)) {
      seen.add(id)
      leaves.push(id)
    }
  }
  for (const memberId of memberIds) {
    const children = childrenByParent.get(memberId)
    if (children && children.length > 0) {
      // Spread first so the sort does not mutate the map's stored array.
      for (const child of [...children].sort((a, b) => a - b)) push(child)
    } else {
      push(memberId)
    }
  }
  return leaves
}

/**
 * Expand ONE hash list to its physical leaf `hash_list.id`s: a #202 split
 * PARENT resolves to its per-type children (one level, ids asc); a homogeneous
 * list IS its own leaf and resolves to `[hashListId]`. Project-scoped — the
 * `project_id = $2` predicate is the IDOR guard, so a list id from another
 * project (or a nonexistent id) resolves to `[hashListId]` (no children found).
 *
 * This is the single-list counterpart to `defaultFetchSuperMemberLeaves`'s
 * per-member expansion (which batches many members in one query). It is the
 * shared primitive `removeMember`'s member-leaf resolution delegates to, so the
 * "children-if-split-parent-else-itself" rule lives in exactly one place.
 */
export async function resolveListToPhysicalLeaves(
  hashListId: number,
  projectId: number
): Promise<number[]> {
  const children = await db
    .select({ id: hashLists.id })
    .from(hashLists)
    .where(and(eq(hashLists.parentHashListId, hashListId), eq(hashLists.projectId, projectId)))
  return children.length > 0
    ? children.map((c) => c.id).sort((a, b) => a - b)
    : [hashListId]
}

/**
 * Resolves a node to its typed leaf hash-list ids — the set a caller reads
 * `hash_items` from and groups (via `groupItemsByMode`) to fan out one typed
 * sub-campaign per leaf.
 *
 * Two variants: the #202 `split-parent` (U5) and the `super` (U10). Adding a
 * further node kind is purely additive — the exhaustiveness guard below turns
 * a missing `case` into a compile error.
 */
export async function resolveNodeToLeaves(node: NodeDescriptor): Promise<number[]> {
  switch (node.kind) {
    case 'split-parent':
      return _nodeResolutionDeps.fetchSplitParentLeaves(node.hashListId, node.projectId)
    case 'super':
      return _nodeResolutionDeps.fetchSuperMemberLeaves(node.superHashListId, node.projectId)
    default: {
      // Exhaustiveness guard: a future `NodeDescriptor` variant added without
      // a matching `case` above stops type-checking here — a compile-time
      // nudge, not a runtime landmine (unreachable for every valid
      // `NodeDescriptor` today).
      const exhaustiveCheck: never = node
      throw new Error(`resolveNodeToLeaves: unhandled node ${JSON.stringify(exhaustiveCheck)}`)
    }
  }
}
