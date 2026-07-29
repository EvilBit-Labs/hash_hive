/**
 * U2 — Match-by-value propagation primitive.
 *
 * propagateCrack fills `plaintext` + `crackedAt` onto every hash_item row
 * that matches the given hash value and has NOT yet been cracked.  It
 * deliberately does NOT touch any attribution FK (campaignId, attackId,
 * taskId, agentId), `username`, or `source` — those columns belong to the
 * agent that originally cracked the hash (KTD2).
 *
 * The returned `updated` count is FOR LOGGING ONLY — it must never be
 * surfaced through an API boundary (KTD7).
 *
 * NOTE FOR U7: the target-list upsert (with provenance) MUST run BEFORE
 * calling propagateCrack.  If propagateCrack runs first it cracks the
 * target rows too, and the subsequent upsert's `crackedAt IS NULL` guard
 * then silently skips them — so provenance would never be written.
 */
import { hashItems, hashLists } from '@hashhive/shared'
import { and, eq, inArray, isNull } from 'drizzle-orm'

import { logger } from '../../config/logger.js'
import { db } from '../../db/index.js'

/**
 * Maximum rows updated per database round-trip.  A single common hash
 * (e.g. NTLM empty-password) could match tens of thousands of rows across
 * projects; batching keeps individual transactions small and avoids
 * long-running row-level locks.  Chosen to sit well below the
 * MAX_ZAPS_LIMIT (10 000) so a full batch never produces a zap payload
 * large enough to stall the event loop.
 */
const PROPAGATION_BATCH_SIZE = 1_000

/**
 * Propagate a newly-cracked plaintext to every uncracked row that shares the
 * SAME `(hashcatMode, hashValue)` key, scoped to a single project
 * (KTD3 / security F2).
 *
 * KTD3 (mode-scoped dedup): the crack-once key is `(mode, value)`, NOT value
 * alone. A 32-hex string can be raw-MD5 (mode 0) in one list and NTLM (mode
 * 1000) in another with unrelated plaintexts, so matching on `hashValue` alone
 * would stamp the wrong plaintext across modes. Candidates are therefore
 * additionally filtered on `detected_hashcat_mode = $hashcatMode`. Rows whose
 * `detectedHashcatMode` is NULL never match (a mode-less row can't be proven to
 * be the same crack), so they are left untouched — consistent with mode-less
 * items never entering the cracked-set. Callers with no resolvable mode MUST
 * NOT call this (they have nothing to cross-list dedup against).
 *
 * `hash_items` has no `projectId` column — it references `hashListId` only —
 * so project scope is enforced by filtering candidates to
 * `hashListId IN (SELECT id FROM hash_lists WHERE project_id = $projectId)`.
 * This closes the pre-existing cross-project plaintext leak: `propagateCrack`
 * used to fill matching rows across ALL projects, exposing one tenant's
 * plaintext to another. Callers must thread the owning project through.
 *
 * Algorithm (SELECT + UPDATE to work around PostgreSQL's lack of
 * UPDATE...LIMIT):
 * 1. SELECT up to PROPAGATION_BATCH_SIZE candidate IDs where
 *    `hash_value = $h AND detected_hashcat_mode = $mode AND cracked_at IS NULL
 *    AND hash_list_id IN (project's lists)`.
 * 2. UPDATE those specific IDs — re-checks `detected_hashcat_mode = $mode` and
 *    `cracked_at IS NULL` so a concurrent agent crack cannot race us into
 *    overwriting its attribution.
 * 3. Repeat until the SELECT returns fewer rows than PROPAGATION_BATCH_SIZE.
 *
 * The `hash_items_hash_value_idx` index (added in U1) makes the SELECT
 * efficient even across large tables.
 *
 * @param hashValue - The hash to match (verbatim, case-sensitive).
 * @param plaintext - The cracked plaintext to write.
 * @param projectId - The owning project; propagation never crosses it.
 * @param hashcatMode - The resolved hashcat mode of the crack; only rows whose
 *   `detectedHashcatMode` equals it are filled (KTD3).
 * @returns Total rows updated.  Use for logging only (KTD7).
 */
export async function propagateCrack(
  hashValue: string,
  plaintext: string,
  projectId: number,
  hashcatMode: number
): Promise<{ updated: number }> {
  let totalUpdated = 0
  const crackedAt = new Date()

  // Project scope: hash_items has no projectId, so restrict to the project's
  // own hash lists (security F2 — never propagate across tenants).
  const projectHashLists = db
    .select({ id: hashLists.id })
    .from(hashLists)
    .where(eq(hashLists.projectId, projectId))

  while (true) {
    const candidates = await db
      .select({ id: hashItems.id })
      .from(hashItems)
      .where(
        and(
          eq(hashItems.hashValue, hashValue),
          // KTD3: same-value rows in a DIFFERENT mode are unrelated cracks.
          eq(hashItems.detectedHashcatMode, hashcatMode),
          isNull(hashItems.crackedAt),
          inArray(hashItems.hashListId, projectHashLists)
        )
      )
      .limit(PROPAGATION_BATCH_SIZE)

    if (candidates.length === 0) {
      break
    }

    const ids = candidates.map((r) => r.id)

    // Re-check crackedAt IS NULL so a concurrent agent crack cannot race
    // us into overwriting its provenance attribution. Re-check the mode too so
    // a concurrent mode re-stamp between SELECT and UPDATE can't slip a
    // now-different-mode row into this fill (KTD3).
    const updated = await db
      .update(hashItems)
      .set({ plaintext, crackedAt })
      .where(
        and(
          inArray(hashItems.id, ids),
          eq(hashItems.detectedHashcatMode, hashcatMode),
          isNull(hashItems.crackedAt)
        )
      )
      .returning({ id: hashItems.id })

    totalUpdated += updated.length

    if (candidates.length < PROPAGATION_BATCH_SIZE) {
      break
    }
  }

  logger.info({ updated: totalUpdated }, 'propagateCrack: propagation complete')

  return { updated: totalUpdated }
}
