/**
 * U4 — Read-time crack-state resolution against the per-project cracked-set
 * (SuperHashlists Layer one, KTD8 / R15 / R17).
 *
 * The U2 write path records one row per cracked `(projectId, hashcatMode,
 * hashValue)` in `project_cracked_hashes` and stamps the resolved mode onto
 * `hash_items.detectedHashcatMode`. This module is the single place every
 * NON-AGENT read surface goes to turn a `hash_items` row into the crack state
 * an operator should actually see: an item that is uncracked in its own row but
 * whose `(mode, value)` is present in the project cracked-set reports **cracked**
 * with the set's plaintext.
 *
 * ## The two shapes of consumer
 *
 * Readers come in two flavors, so this module exposes two matched primitives:
 *
 *   1. **Row readers** — already hold `hash_items` rows in memory and only need
 *      the effective crack state per row: use {@link resolveCrackState}.
 *   2. **Query readers** — filter/aggregate/paginate in SQL (`count(distinct …)`,
 *      `WHERE cracked_at IS NOT NULL`, `ORDER BY cracked_at`) and cannot correct
 *      the answer after the fact: `LEFT JOIN projectCrackedHashes ON`
 *      {@link crackedSetJoinOn} and read through {@link RESOLVED_IS_CRACKED} /
 *      {@link RESOLVED_CRACKED_AT} / {@link RESOLVED_PLAINTEXT} /
 *      {@link RESOLVED_CRACKED_VALUE}.
 *
 * Both resolve on exactly the same key and both honor the same invariants.
 *
 * ## Invariants
 *
 * - **KTD3 (one authoritative mode).** The join key is
 *   `(projectId, hash_items.detectedHashcatMode, hash_items.hashValue)` — the
 *   very column U2 stamps at crack time. Never a campaign-latched mode, never a
 *   re-detection. An item whose `detectedHashcatMode` is NULL is NEVER marked
 *   cracked by this module (SQL: `NULL = anything` is NULL, so the LEFT JOIN
 *   cannot match; TS: the pair is not even looked up).
 * - **AE1 (mode mismatch is not a match).** A 32-hex value can be raw-MD5 or
 *   NTLM with unrelated plaintexts. An item whose mode differs from a cracked-set
 *   row of the same value resolves **uncracked** — the value alone is not a key.
 * - **Own row wins.** An item cracked in its own row keeps its own plaintext and
 *   `crackedAt`; the cracked-set only ever *fills* state, never overwrites it.
 * - **R17 (no source-list exposure).** The match reference for a cross-list fill
 *   is the row-local `project_cracked_hashes.sourceHashListId` written by U2. It
 *   is deliberately absent from {@link ResolvedCrackState} and from every SQL
 *   helper's projection, so a sub-admin read endpoint cannot serialize it even by
 *   accident: a list-A viewer learns the plaintext, never that list B produced it,
 *   and never list B's `user`/`source`/identity. The reference is *recorded*
 *   (persisted on the cracked-set row + emitted to the structured log on fill),
 *   not *returned*.
 *
 * ## Not in scope
 *
 * - The **agent surface** (`routes/agent/*`) never calls this. Agents already get
 *   project-wide crack-once through the widened zap scan (U3, `tasks/zaps.ts`),
 *   which reads the same cracked-set directly.
 * - **Export** (`services/results/export.ts`, `routes/control/export.ts`) is U14.
 */
import { hashItems, projectCrackedHashes } from '@hashhive/shared'
import { and, eq, sql, type SQL } from 'drizzle-orm'

import { logger } from '../../config/logger.js'
import { db } from '../../db/index.js'

// ─── SQL-level resolution (query readers) ────────────────────────────────────

/**
 * ON condition for `LEFT JOIN projectCrackedHashes` against a query whose FROM
 * side already includes `hashItems`.
 *
 * Keys on `(projectId, detectedHashcatMode, hashValue)` — exactly the columns of
 * the `project_cracked_hashes_project_mode_value_idx` UNIQUE index, so the join
 * is at most 1:1 and can never multiply rows (`count(hashItems.id)` and
 * pagination totals are unaffected by adding it).
 *
 * A NULL `detectedHashcatMode` makes the equality NULL, so no cracked-set row
 * can ever match a mode-less item (KTD3). A mode that differs from the
 * cracked-set row's mode does not match either (AE1).
 */
export function crackedSetJoinOn(projectId: number): SQL {
  return and(
    eq(projectCrackedHashes.projectId, projectId),
    eq(projectCrackedHashes.hashcatMode, hashItems.detectedHashcatMode),
    eq(projectCrackedHashes.hashValue, hashItems.hashValue)
  )!
}

/**
 * Boolean predicate: the item is cracked in its own row OR the project
 * cracked-set holds its `(mode, value)`. Usable both in `WHERE` and inside a
 * `FILTER (WHERE …)` / `CASE WHEN` aggregate.
 */
export const RESOLVED_IS_CRACKED: SQL<boolean> = sql<boolean>`(${hashItems.crackedAt} is not null or ${projectCrackedHashes.id} is not null)`

/**
 * Effective crack timestamp. Prefers the item's own crack; for a cross-list fill
 * it reports the cracked-set's *provenance* time (`originalCrackedAt`) rather
 * than the insert-monotonic keyset column, so the operator sees when the value
 * was actually first cracked. `crackedAt` is the fallback for pre-provenance rows.
 *
 * `.mapWith(hashItems.crackedAt)` is LOAD-BEARING: postgres-js hands raw SQL
 * expressions back with a transparent parser, so without it a `timestamptz`
 * from `coalesce(...)` arrives as the string `'2026-01-02 03:04:05+00'` instead
 * of a `Date` — silently changing the wire shape of every migrated reader.
 * Borrowing the column's own decoder keeps the projection a `Date | null`.
 */
export const RESOLVED_CRACKED_AT: SQL<Date | null> =
  sql<Date | null>`coalesce(${hashItems.crackedAt}, ${projectCrackedHashes.originalCrackedAt}, ${projectCrackedHashes.crackedAt})`.mapWith(
    hashItems.crackedAt
  )

/** Effective plaintext. The item's own row wins; the cracked-set only fills. */
export const RESOLVED_PLAINTEXT: SQL<string | null> = sql<
  string | null
>`coalesce(${hashItems.plaintext}, ${projectCrackedHashes.plaintext})`

/**
 * The item's `hashValue` when it resolves cracked, else NULL — the argument for
 * `count(distinct …)` cracked-target aggregates. Deduping on the value (rather
 * than counting rows) keeps one cracked target counted once even when it exists
 * as separate `hash_items` rows under sibling sub-lists.
 */
export const RESOLVED_CRACKED_VALUE: SQL<string | null> = sql<
  string | null
>`case when ${RESOLVED_IS_CRACKED} then ${hashItems.hashValue} end`

// ─── In-memory resolution (row readers) ──────────────────────────────────────

/**
 * The minimum a caller must carry for a row to be resolvable. Every field is a
 * `hash_items` column; callers pass their own wider row shape structurally.
 */
export interface ResolvableHashItem {
  readonly hashValue: string
  /** KTD3: the ONE authoritative mode column the write path stamps. */
  readonly detectedHashcatMode: number | null
  readonly crackedAt: Date | null
  readonly plaintext: string | null
}

/**
 * Effective crack state for one item.
 *
 * R17: intentionally carries NO source-list identity. `sourceHashListId`, the
 * source list's name, its `user`, and its `source` are all absent by
 * construction — this type is the boundary that makes cross-list attribution
 * unserializable.
 */
export interface ResolvedCrackState {
  /** True when the item is cracked in its own row or via the project cracked-set. */
  readonly cracked: boolean
  readonly crackedAt: Date | null
  readonly plaintext: string | null
  /**
   * True only when the state came from the cracked-set because the item's own
   * row had none. Internal signal (telemetry / "cracked elsewhere in this
   * project" affordances) — do not serialize source identity alongside it.
   */
  readonly crossList: boolean
}

/** Postgres caps a statement at 65535 bind parameters; 2 per pair, chunked well under. */
const LOOKUP_CHUNK_SIZE = 500

function pairKey(mode: number, value: string): string {
  // A hashcat mode is an integer, so a colon can never appear in the mode
  // component — the split point is unambiguous and the key is collision-free.
  return `${mode}:${value}`
}

/**
 * Resolve effective crack state for a batch of hash items against the project
 * cracked-set.
 *
 * Returns one {@link ResolvedCrackState} per input item, **index-aligned with
 * `items`** — `result[i]` is the state of `items[i]`.
 *
 * Only items that are uncracked in their own row and carry a non-null
 * `detectedHashcatMode` are looked up, so a page of already-cracked or mode-less
 * rows costs zero queries. Distinct `(mode, value)` pairs are deduplicated before
 * the lookup, so N rows of the same value cost one key.
 *
 * @param items     Hash-item rows (any shape satisfying {@link ResolvableHashItem}).
 * @param projectId Project scope. Cracked-set rows from another project can never
 *                  match — the filter is on the indexed leading column.
 */
export async function resolveCrackState(
  items: readonly ResolvableHashItem[],
  projectId: number
): Promise<ResolvedCrackState[]> {
  // Pairs worth looking up: uncracked in their own row (own row wins) AND with a
  // resolved mode (KTD3 — a mode-less item is never marked cracked).
  const pairs = new Map<string, { mode: number; value: string }>()
  for (const item of items) {
    if (item.crackedAt !== null) continue
    const mode = item.detectedHashcatMode
    if (mode === null) continue
    pairs.set(pairKey(mode, item.hashValue), { mode, value: item.hashValue })
  }

  const matches =
    pairs.size > 0
      ? await fetchCrackedSetMatches(projectId, [...pairs.values()])
      : new Map<string, CrackedSetMatch>()

  const resolved: ResolvedCrackState[] = []
  let crossListFills = 0
  for (const item of items) {
    if (item.crackedAt !== null) {
      resolved.push({
        cracked: true,
        crackedAt: item.crackedAt,
        plaintext: item.plaintext,
        crossList: false,
      })
      continue
    }
    const mode = item.detectedHashcatMode
    const match = mode === null ? undefined : matches.get(pairKey(mode, item.hashValue))
    if (match === undefined) {
      resolved.push({ cracked: false, crackedAt: null, plaintext: null, crossList: false })
      continue
    }
    crossListFills += 1
    resolved.push({
      cracked: true,
      // Provenance time for display; the keyset column is the fallback.
      crackedAt: match.originalCrackedAt ?? match.crackedAt,
      plaintext: match.plaintext,
      crossList: true,
    })
  }

  if (crossListFills > 0) {
    // R17 match reference: the durable record is the cracked-set row's
    // `sourceHashListId` (written by U2). Logged here — never returned to the
    // caller, never serialized to a sub-admin read endpoint.
    logger.debug(
      {
        projectId,
        crossListFills,
        sourceHashListIds: [...new Set([...matches.values()].map((m) => m.sourceHashListId))],
      },
      'crack-resolution: filled crack state from the project cracked-set'
    )
  }

  return resolved
}

/** Cracked-set row as this module consumes it. Never crosses the API boundary. */
interface CrackedSetMatch {
  readonly plaintext: string | null
  readonly crackedAt: Date
  readonly originalCrackedAt: Date | null
  /** R17 row-local match reference — logged for audit, never serialized. */
  readonly sourceHashListId: number | null
}

async function fetchCrackedSetMatches(
  projectId: number,
  pairs: ReadonlyArray<{ mode: number; value: string }>
): Promise<Map<string, CrackedSetMatch>> {
  const matches = new Map<string, CrackedSetMatch>()

  for (let start = 0; start < pairs.length; start += LOOKUP_CHUNK_SIZE) {
    const chunk = pairs.slice(start, start + LOOKUP_CHUNK_SIZE)
    // Row-wise IN over the UNIQUE `(projectId, hashcatMode, hashValue)` index.
    const tuples = sql.join(
      chunk.map((p) => sql`(${p.mode}, ${p.value})`),
      sql`, `
    )
    const rows = await db
      .select({
        hashcatMode: projectCrackedHashes.hashcatMode,
        hashValue: projectCrackedHashes.hashValue,
        plaintext: projectCrackedHashes.plaintext,
        crackedAt: projectCrackedHashes.crackedAt,
        originalCrackedAt: projectCrackedHashes.originalCrackedAt,
        sourceHashListId: projectCrackedHashes.sourceHashListId,
      })
      .from(projectCrackedHashes)
      .where(
        and(
          eq(projectCrackedHashes.projectId, projectId),
          sql`(${projectCrackedHashes.hashcatMode}, ${projectCrackedHashes.hashValue}) in (${tuples})`
        )
      )

    for (const row of rows) {
      matches.set(pairKey(row.hashcatMode, row.hashValue), {
        plaintext: row.plaintext,
        crackedAt: row.crackedAt,
        originalCrackedAt: row.originalCrackedAt,
        sourceHashListId: row.sourceHashListId,
      })
    }
  }

  return matches
}
