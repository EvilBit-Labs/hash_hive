/**
 * Hash-list scope resolution for the mixed-list split feature (#202, SU4).
 *
 * A split PARENT hash list (`hash_lists.parent_hash_list_id IS NULL` on
 * itself, but 1+ rows reference it as their parent) has its own
 * `hash_items` MOVED off to its sub-lists during the split — the parent's
 * own item set is empty. Every read path that scopes on a single
 * `hashListId` therefore needs to expand a parent id to "the parent plus
 * its children" before filtering `hash_items`, or a parent-scoped read
 * silently sees zero rows post-split.
 *
 * A normal (never-split) hash list has `parent_hash_list_id IS NULL` and no
 * children, so this resolves to `[id]` — identical to the un-split
 * behavior every caller had before SU4.
 */
import { hashLists } from '@hashhive/shared'
import { and, eq, or } from 'drizzle-orm'

import { db } from '../../db/index.js'

/**
 * Resolve `id` to the set of `hash_lists.id` values a caller should filter
 * `hash_items.hash_list_id` against, scoped to `projectId`.
 *
 * Semantics:
 *   - Leaf list (no children): returns `[id]`. Identical to filtering on
 *     `id` directly — the pre-split behavior every existing caller relied
 *     on is preserved exactly.
 *   - Parent list (1+ hash_lists rows with `parent_hash_list_id = id`):
 *     returns `[id, ...childIds]`. Including the parent's own id is
 *     harmless — a split parent's `hash_items` are empty by construction
 *     (SU1-3 move rows to children rather than duplicating them) — so it
 *     contributes zero rows to any query filtered by the returned set. It
 *     is kept in the result anyway rather than filtered out, since
 *     omitting it would require distinguishing "leaf" from "parent" here
 *     for no behavioral gain.
 *   - Exactly ONE level of expansion: a child's own children (grandchild
 *     nesting) are never walked. The current split design (SU1-3)
 *     produces exactly one level of sub-lists, so this is not a
 *     limitation today, but a future nested-split feature would need a
 *     new helper (or a recursive CTE) rather than assuming this function
 *     walks arbitrarily deep.
 *   - IDOR guard: if `id` does not belong to `projectId` (wrong project,
 *     or the id does not exist), returns `[]`. The `project_id = $2`
 *     predicate applies to every row in the result set — including
 *     children — so expansion can never cross a project boundary even if
 *     a caller somehow supplied a cross-project id. (In practice a DB
 *     trigger already pins every sub-list's `project_id` to its parent's,
 *     so this is defense in depth, not the only guard.)
 *
 * Single round trip: `select id from hash_lists where (id = $1 or
 * parent_hash_list_id = $1) and project_id = $2`.
 */
export async function resolveHashListScope(id: number, projectId: number): Promise<number[]> {
  const rows = await db
    .select({ id: hashLists.id })
    .from(hashLists)
    .where(
      and(
        or(eq(hashLists.id, id), eq(hashLists.parentHashListId, id)),
        eq(hashLists.projectId, projectId)
      )
    )
  return rows.map((r) => r.id)
}
