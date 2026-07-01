import '../openapi-extension.js'
import { z } from 'zod'

/**
 * Shared Zod schemas for the global hash-search feature (issue #102).
 *
 * R14: searchHashes returns per-list matches with crack state across all
 * hash lists in a project.
 *
 * R15: Both cracked and uncracked rows are returned — crackedAt is null
 * for uncracked rows.
 *
 * R16: Project scope is enforced at the service layer (JOIN on
 * hashLists.projectId = projectId). These schemas carry no project-scope
 * information themselves; the boundary is the service's WHERE clause.
 *
 * A single hashValue may appear in multiple hash lists in the same project
 * and therefore produce multiple result rows — one per (hashListId, hashValue).
 *
 * crackedAt is an ISO 8601 datetime string on the wire (Date → JSON
 * serialization), or null for uncracked rows. This matches the convention
 * in crackedResultRowSchema. Service-layer consumers that see a Date object
 * must not parse this schema directly against the service ReturnType — use
 * it for route response validation and round-trip tests (KTD8).
 */

export const hashSearchResultSchema = z
  .object({
    hashValue: z.string(),
    hashListId: z.number().int().positive(),
    hashListName: z.string(),
    crackedAt: z.string().datetime().nullable(),
  })
  .strict()
  .openapi('HashSearchResult')

/**
 * Paginated list of per-list hash-search results.
 *
 * Pagination shape mirrors listResultsResponseSchema: results + total +
 * limit + offset. The route layer echoes back the effective limit/offset
 * after clamping.
 */
export const hashSearchResponseSchema = z
  .object({
    results: z.array(hashSearchResultSchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
  })
  .strict()
  .openapi('HashSearchResponse')
