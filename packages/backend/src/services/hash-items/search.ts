/**
 * U10 — Global hash-search service.
 *
 * searchHashes returns per-list rows for every hash_item whose hashValue
 * either exactly equals the query OR contains it as a substring (ILIKE).
 *
 * Requirements:
 *   R14 — Search across all of a project's hash lists in one call.
 *   R15 — Return both cracked and uncracked rows; crackedAt is null for
 *          uncracked rows.  No crackedAt filter here.
 *   R16 — Strictly project-scoped via a JOIN on hashLists.projectId.
 *          Cross-project rows can never appear.
 *   R17 — Literal % / _ in the query are escaped via escapeLike so they
 *          are never treated as ILIKE wildcards.
 *
 * A single hashValue may appear in multiple hash lists in the same project
 * and therefore produces multiple rows — one per (hashListId, hashValue).
 * The caller (route layer, U11) is responsible for presenting this correctly.
 *
 * Pagination defaults: limit 50, max 100, offset 0.
 * These constants mirror RESULTS_LIST_DEFAULT_LIMIT / RESULTS_LIST_MAX_LIMIT
 * from packages/backend/src/routes/dashboard/results.ts so callers can apply
 * consistent caps without importing private route constants.
 */
import { hashItems, hashLists } from '@hashhive/shared'
import { and, count, eq, or, sql } from 'drizzle-orm'

import { logger } from '../../config/logger.js'
import { db } from '../../db/index.js'
import { escapeLike } from '../resources.js'

export const SEARCH_DEFAULT_LIMIT = 50
export const SEARCH_MAX_LIMIT = 100
export const SEARCH_DEFAULT_OFFSET = 0

export interface SearchHashesResult {
  results: {
    hashValue: string
    hashListId: number
    hashListName: string
    crackedAt: Date | null
  }[]
  total: number
  limit: number
  offset: number
}

/**
 * Search for hash_item rows matching `query` within the given project.
 *
 * Matching logic:
 *   - Exact case-sensitive equality (index path: hash_items_hash_value_idx)
 *   - ILIKE substring with `%query%` (case-insensitive, slower but broader)
 *
 * Both branches are combined with OR so the result set equals
 * ILIKE-alone (exact match is a subset of ILIKE-substring), but the
 * separate exact branch allows the planner to use the index for common
 * lookups where the full hash value is known (KTD6).
 *
 * @param projectId  Owner project; enforced via the hashLists JOIN.
 * @param query      Search string. May be an empty string (returns all rows).
 * @param opts       Optional limit (capped to SEARCH_MAX_LIMIT) and offset.
 */
export async function searchHashes(
  projectId: number,
  query: string,
  opts: { limit?: number | undefined; offset?: number | undefined } = {}
): Promise<SearchHashesResult> {
  const limit = Math.min(opts.limit ?? SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT)
  const offset = opts.offset ?? SEARCH_DEFAULT_OFFSET

  const escaped = escapeLike(query)

  // Project-scope guard: only rows whose hash list belongs to projectId.
  const projectScope = and(
    eq(hashItems.hashListId, hashLists.id),
    eq(hashLists.projectId, projectId)
  )

  // Match clause: exact equality OR case-insensitive substring.
  // escapeLike neutralises any % / _ / \ in the query so they are never
  // treated as wildcard metacharacters by the database (R17).
  const matchClause = or(
    eq(hashItems.hashValue, query),
    sql`${hashItems.hashValue} ILIKE ${`%${escaped}%`} ESCAPE '\\'`
  )

  const whereClause = and(projectScope, matchClause)

  logger.debug({ projectId, query, limit, offset }, 'searchHashes: querying')

  const [rows, countRows] = await Promise.all([
    db
      .select({
        hashValue: hashItems.hashValue,
        hashListId: hashLists.id,
        hashListName: hashLists.name,
        crackedAt: hashItems.crackedAt,
      })
      .from(hashItems)
      .innerJoin(hashLists, eq(hashItems.hashListId, hashLists.id))
      .where(whereClause)
      .limit(limit)
      .offset(offset),

    db
      .select({ count: count() })
      .from(hashItems)
      .innerJoin(hashLists, eq(hashItems.hashListId, hashLists.id))
      .where(whereClause),
  ])

  const total = Number(countRows[0]?.count ?? 0)

  logger.debug({ projectId, query, total, returned: rows.length }, 'searchHashes: done')

  return { results: rows, total, limit, offset }
}
