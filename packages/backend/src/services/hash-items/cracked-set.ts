/**
 * U2 — Maintained per-project cracked-set write path (SuperHashlists Layer one).
 *
 * `upsertCrackedSet` records one row per distinct cracked
 * `(projectId, hashcatMode, hashValue)` in `project_cracked_hashes` — the single
 * source for project-wide crack-once (the widened agent zap lookup, KTD4, and
 * read-time crack-state resolution, KTD8, both resolve against it).
 *
 * KTD2 (insert-monotonic keyset): the keyset column `crackedAt` is ALWAYS stamped
 * with the application `Date` at insert time and is NEVER moved on conflict. The
 * exactly-once zap cursor requires that no row is inserted BEHIND an active
 * cursor's position, so a re-crack refreshes `plaintext` in place but leaves the
 * scan order untouched. True first-crack provenance lives in `originalCrackedAt`,
 * which the keyset never reads. Never a DB-side now()/defaultNow()/trigger.
 *
 * KTD3 (one authoritative resolved mode): the dedup key is `(mode, value)` — not
 * value alone — because a 32-hex string can be raw-MD5 or NTLM with unrelated
 * plaintexts (AE1). A result whose hashcat mode is unresolved (null) does NOT
 * enter the cracked-set and does not cross-list dedup; `upsertCrackedSet` no-ops
 * in that case so the caller can pass results uniformly.
 */
import { hashItems, projectCrackedHashes } from '@hashhive/shared'
import { inArray, sql } from 'drizzle-orm'

import type { db } from '../../db/index.js'

/** Drizzle transaction handle — the callback argument type of `db.transaction`. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

export interface UpsertCrackedSetInput {
  projectId: number
  /**
   * Resolved hashcat mode for this crack (KTD3). When `null`/`undefined` the
   * row is skipped — items with no resolvable mode never cross-list dedup.
   */
  hashcatMode: number | null | undefined
  hashValue: string
  plaintext: string
  /** Row-local match reference (R17): the list whose crack populated this row. */
  sourceHashListId?: number | null
  taskId?: number | null
  agentId?: number | null
}

/**
 * Upsert one cracked `(projectId, hashcatMode, hashValue)` row inside the
 * caller's transaction. On first insert, both the keyset `crackedAt` and the
 * provenance `originalCrackedAt` are stamped with the same application `Date`.
 * On conflict, ONLY `plaintext` is refreshed — `crackedAt` is deliberately NOT
 * in the SET so the keyset ordering stays monotonic in insert order (KTD2).
 *
 * No-ops when `hashcatMode` is null/undefined (KTD3).
 */
export async function upsertCrackedSet(tx: Tx, input: UpsertCrackedSetInput): Promise<void> {
  const { projectId, hashcatMode, hashValue, plaintext, sourceHashListId, taskId, agentId } = input

  // KTD3: a result with no resolved hashcat mode never enters the cracked-set.
  if (hashcatMode == null) return

  const now = new Date()

  await tx
    .insert(projectCrackedHashes)
    .values({
      projectId,
      hashcatMode,
      hashValue,
      plaintext,
      // KTD2: keyset column stamped at insert; provenance mirrors it on first crack.
      crackedAt: now,
      originalCrackedAt: now,
      sourceHashListId: sourceHashListId ?? null,
      taskId: taskId ?? null,
      agentId: agentId ?? null,
    })
    .onConflictDoUpdate({
      target: [
        projectCrackedHashes.projectId,
        projectCrackedHashes.hashcatMode,
        projectCrackedHashes.hashValue,
      ],
      // KTD2: refresh plaintext only. Do NOT set crackedAt here — moving the
      // keyset column would reorder the row behind live zap cursors and break
      // exactly-once pagination.
      set: {
        plaintext: sql`EXCLUDED.plaintext`,
      },
    })
}

/**
 * U12 — Retroactive backfill of a hash list's already-cracked hashes into the
 * project cracked-set, run when the list is added as a super member (R9, AE3).
 *
 * `leafHashListIds` is the member's PHYSICAL leaf set — for a homogeneous
 * member that is `[hashListId]` (the caller resolves it via
 * `resolveListToPhysicalLeaves`), but for a #202 split-parent member it is the
 * parent's per-type CHILDREN: a split parent's own `hash_items` are moved to
 * its children at split time (the parent is an empty shell), so backfilling
 * against the bare parent id would match zero rows and silently skip the
 * reconciliation. Querying the leaf set instead makes the backfill correct for
 * both member shapes.
 *
 * Every `(mode, value)` already cracked across those leaves' OWN `hash_items`
 * (`crackedAt IS NOT NULL`, with a resolved mode and plaintext) that is not yet
 * in the set is inserted, so an uncracked duplicate of that value in a sibling
 * member immediately resolves cracked at read time (U4) with no re-attack. A
 * single `INSERT … SELECT … ON CONFLICT DO NOTHING` lets Postgres do the whole
 * set operation server-side (no round-tripping rows), and is naturally
 * idempotent — re-running it inserts nothing new and never moves an existing
 * `crackedAt`.
 *
 * KTD2 / adversarial F1 (the load-bearing subtlety): the keyset column
 * `crackedAt` is stamped with the CURRENT time (`now`), NOT the member's
 * historical crack time — a backfilled row must sort AHEAD of, never behind,
 * live agent zap cursors, or the project would silently skip re-emitting it and
 * fail to cross-list dedup. The member's true first-crack time is preserved in
 * `originalCrackedAt` (which the keyset never reads), so provenance is intact.
 *
 * KTD3: rows with no resolved `detectedHashcatMode` are excluded — they never
 * cross-list dedup. Because `hash_items` is UNIQUE on `(hashListId, hashValue)`,
 * each leaf yields at most one row per `(mode, value)`, but two SIBLING leaves
 * (e.g. two children of the same split parent) could each hold the value —
 * `ON CONFLICT DO NOTHING` absorbs that without extra handling.
 *
 * A no-op for an empty `leafHashListIds` (defense-in-depth; callers should
 * never pass one, since `resolveListToPhysicalLeaves` always returns at least
 * `[hashListId]`).
 */
export async function backfillCrackedSetFromMember(
  tx: Tx,
  projectId: number,
  leafHashListIds: number[]
): Promise<void> {
  if (leafHashListIds.length === 0) return

  // App-controlled stamp (KTD2 — not a DB-side now()). Bound as an ISO string
  // with an explicit cast: in a SELECT constant position postgres-js has no
  // column type to infer from, so a raw `Date` param fails to serialize —
  // a `text`→`timestamptz` cast binds cleanly while keeping the app's clock.
  const now = new Date().toISOString()

  await tx.execute(sql`
    INSERT INTO ${projectCrackedHashes}
      (project_id, hashcat_mode, hash_value, plaintext, cracked_at, original_cracked_at, source_hash_list_id)
    SELECT
      ${projectId},
      ${hashItems.detectedHashcatMode},
      ${hashItems.hashValue},
      ${hashItems.plaintext},
      ${now}::timestamptz,
      ${hashItems.crackedAt},
      ${hashItems.hashListId}
    FROM ${hashItems}
    WHERE ${inArray(hashItems.hashListId, leafHashListIds)}
      AND ${hashItems.crackedAt} IS NOT NULL
      AND ${hashItems.detectedHashcatMode} IS NOT NULL
      AND ${hashItems.plaintext} IS NOT NULL
    ON CONFLICT (project_id, hashcat_mode, hash_value) DO NOTHING
  `)
}
