/**
 * Hash-lists listing wire shape (issue #165 / plan U2).
 *
 * Project-scoped summary returned by `GET /api/v1/dashboard/hash-lists`.
 * Source data for the global Results page's hash-list filter dropdown
 * and the hash list detail stats card. Counts come from a LEFT JOIN
 * aggregate over `hash_items` so a hash list with zero items returns
 * `hashCount=0, crackedCount=0` rather than being dropped from the
 * listing.
 *
 * Per AGENTS.md: wire shapes live in `@hashhive/shared` as `z.infer`
 * from Zod schemas. Per the dashboard read-endpoint contract
 * (`docs/solutions/conventions/dashboard-read-endpoint-contract.md`),
 * counts are JavaScript `number` on the wire — postgres-js returns
 * `count(*)` as a string at runtime, so the route coerces via
 * `Number(...)` (precedent in `dashboard/stats.ts` and
 * `dashboard/results.ts`).
 */

import '../openapi-extension.js'
import { z } from 'zod'

export const hashListSummarySchema = z
  .object({
    id: z.number().int().positive(),
    name: z.string(),
    hashTypeId: z.number().int().positive().nullable(),
    hashCount: z.number().int().nonnegative(),
    crackedCount: z.number().int().nonnegative(),
  })
  .strict()
  .openapi('HashListSummary')

export const hashListListResponseSchema = z
  .object({
    hashLists: z.array(hashListSummarySchema),
  })
  .strict()
  .openapi('HashListListResponse')
