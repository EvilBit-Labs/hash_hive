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
import { projectCrackedHashes } from '@hashhive/shared'
import { sql } from 'drizzle-orm'

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
