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
  .refine((row) => row.crackedCount <= row.hashCount, {
    message: 'crackedCount cannot exceed hashCount',
    path: ['crackedCount'],
  })
  .openapi('HashListSummary')

export const hashListListResponseSchema = z
  .object({
    hashLists: z.array(hashListSummarySchema),
  })
  .strict()
  .openapi('HashListListResponse')

/**
 * Per-list hash-type analysis (foundation toward #202).
 *
 * Accumulated during ingestion (`queue/workers/hash-list-parser.ts`) by running
 * each entry through `guessTopHashType` and counting detected hashcat modes.
 * Persisted to the nullable `hash_lists.type_analysis` jsonb column
 * (`null` = not yet analyzed / legacy list). This is the source of the split
 * work's mixed-list trigger in #202's second half.
 *
 * - `verdict`: `homogeneous` (one detected mode within noise), `mixed` (2+ modes
 *   above the noise threshold), or `needs-review` (unidentified entries dominate
 *   or declared-vs-detected mismatch).
 * - `detectedModes`: histogram of detected hashcat modes, sorted by count desc.
 * - `sampled`: true when the list exceeded the scan cap and detection stopped
 *   early (all rows still insert).
 * - `declaredMode`: the list's declared hashcat mode when set, for mismatch
 *   detection; null otherwise.
 * - `analyzedAt`: ISO-8601 timestamp of when the analysis was computed.
 */
export const hashListDetectedModeSchema = z
  .object({
    hashcatMode: z.number().int().nonnegative(),
    count: z.number().int().nonnegative(),
  })
  .strict()
  .openapi('HashListDetectedMode')

export const hashListTypeAnalysisSchema = z
  .object({
    verdict: z.enum(['homogeneous', 'mixed', 'needs-review']),
    detectedModes: z.array(hashListDetectedModeSchema),
    unidentifiedCount: z.number().int().nonnegative(),
    scannedCount: z.number().int().nonnegative(),
    sampled: z.boolean(),
    declaredMode: z.number().int().nonnegative().nullable(),
    analyzedAt: z.string().datetime(),
  })
  .strict()
  .refine((a) => a.unidentifiedCount <= a.scannedCount, {
    message: 'unidentifiedCount cannot exceed scannedCount',
    path: ['unidentifiedCount'],
  })
  .openapi('HashListTypeAnalysis')

export type HashListDetectedMode = z.infer<typeof hashListDetectedModeSchema>
export type HashListTypeAnalysis = z.infer<typeof hashListTypeAnalysisSchema>
