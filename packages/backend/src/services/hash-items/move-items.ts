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
 */
import { hashItems } from '@hashhive/shared'
import { inArray } from 'drizzle-orm'

import type { db } from '../../db/index.js'

// Drizzle transaction handle — the callback argument type of `db.transaction`.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Reassigns a batch of `hash_items` rows to `targetHashListId`. Pass
 * `detectedHashcatMode` to stamp every moved item's resolved mode in the
 * same UPDATE (confident split groups, or a resolved ambiguous/merged
 * group); omit it to leave `detected_hashcat_mode` untouched (unidentified
 * groups). No-ops on an empty `itemIds` array.
 */
export async function moveHashItemsToList(
  tx: Tx,
  itemIds: readonly number[],
  targetHashListId: number,
  detectedHashcatMode?: number | null
): Promise<void> {
  if (itemIds.length === 0) return

  await tx
    .update(hashItems)
    .set({
      hashListId: targetHashListId,
      ...(detectedHashcatMode !== undefined ? { detectedHashcatMode } : {}),
    })
    .where(inArray(hashItems.id, [...itemIds]))
}
