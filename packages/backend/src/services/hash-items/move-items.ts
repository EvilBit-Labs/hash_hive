/**
 * Shared `hash_items` reassignment helper (issue #202).
 *
 * Extracted from `queue/workers/hash-list-split.ts` (SU2) so the campaign
 * split-confirm flow (SU3, `services/campaign-split.ts`) can move items
 * between two EXISTING sub-lists during a same-mode merge (KTD6) without
 * duplicating the UPDATE. Both callers move a batch of `hash_items` rows to
 * a new `hash_list_id`, optionally stamping `detected_hashcat_mode` in the
 * same statement.
 *
 * Safe against the caller's unique `(hash_list_id, hash_value)` index for
 * both use cases: SU2 moves items out of a parent into a *fresh* child (no
 * pre-existing rows to collide with), and SU3's merge moves items between
 * two children of the SAME parent — since a hash list can never contain a
 * duplicate `hashValue` (ingestion's `onConflictDoNothing`), two sub-lists
 * that partition the same parent's items can never share a `hashValue`
 * either, so a merge cannot collide.
 *
 * `itemIds` is chunked into `MOVE_BATCH_SIZE`-sized UPDATEs (mirrors
 * `PROPAGATION_BATCH_SIZE` in `hash-items/propagation.ts` /
 * `IMPORT_BATCH_SIZE` in `hash-import-worker.ts`) — drizzle's `inArray`
 * compiles to one bound parameter per id, and a single UPDATE with well
 * over ~65k ids throws at bind time (PostgreSQL's parameter-count limit),
 * which would roll back the whole enclosing transaction. A split of a
 * 1M+-row hash list would otherwise hit that ceiling in one group.
 */
import { hashItems } from '@hashhive/shared'
import { inArray } from 'drizzle-orm'

import type { db } from '../../db/index.js'

// Drizzle transaction handle — the callback argument type of `db.transaction`.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** Max `hash_items` rows reassigned per UPDATE — see module doc comment. */
export const MOVE_BATCH_SIZE = 1_000

/**
 * Reassigns a batch of `hash_items` rows to `targetHashListId`. Pass
 * `detectedHashcatMode` to stamp every moved item's resolved mode in the
 * same UPDATE (confident split groups, or a resolved ambiguous/merged
 * group); omit it to leave `detected_hashcat_mode` untouched (unidentified
 * groups). No-ops on an empty `itemIds` array. Issues one UPDATE per
 * `batchSize`-sized chunk of `itemIds`, all inside the caller's `tx` — the
 * `batchSize` parameter defaults to `MOVE_BATCH_SIZE` and exists mainly so
 * tests can exercise the multi-chunk path without seeding a
 * production-sized fixture.
 */
export async function moveHashItemsToList(
  tx: Tx,
  itemIds: readonly number[],
  targetHashListId: number,
  detectedHashcatMode?: number | null,
  batchSize: number = MOVE_BATCH_SIZE
): Promise<void> {
  if (itemIds.length === 0) return

  for (let i = 0; i < itemIds.length; i += batchSize) {
    const chunk = itemIds.slice(i, i + batchSize)
    await tx
      .update(hashItems)
      .set({
        hashListId: targetHashListId,
        ...(detectedHashcatMode !== undefined ? { detectedHashcatMode } : {}),
      })
      .where(inArray(hashItems.id, chunk))
  }
}
