import '../openapi-extension.js'
import { z } from 'zod'

/**
 * Hashcat attack-mode lookup. Maps the integer `mode` value the hashcat
 * agent reports (and the `attacks.mode` column carries) to a human-readable
 * display name. Stable across hashcat 5/6/7 — modes are part of the public
 * CLI contract.
 *
 * Used by:
 *   - Dashboard Results API (`routes/dashboard/results.ts`) to resolve
 *     `attackModeName` on each cracked-result row and the CSV `attack`
 *     column.
 *   - Future frontend filter dropdowns that need integer-to-name mapping
 *     (issue #165) consume it via the shared package re-export.
 */
export const HASHCAT_ATTACK_MODE_NAMES: Readonly<Record<number, string>> = {
  0: 'Dictionary',
  1: 'Combination',
  3: 'Mask',
  6: 'Hybrid Wordlist + Mask',
  7: 'Hybrid Mask + Wordlist',
  9: 'Association',
} as const

/**
 * Resolve a hashcat attack-mode integer to its display name. Returns `null`
 * for unknown modes (forward compatibility — hashcat occasionally adds modes
 * and dashboards on older builds shouldn't crash) and for `null` input.
 */
export function resolveAttackModeName(mode: number | null | undefined): string | null {
  if (mode === null || mode === undefined) return null
  return HASHCAT_ATTACK_MODE_NAMES[mode] ?? null
}

// ─── Wire shapes ─────────────────────────────────────────────────────
//
// All schemas crossing the dashboard API boundary live in
// `@hashhive/shared` per AGENTS.md so the backend route and the
// (future) frontend `useResults` hook share one source of truth.

/**
 * Query parameters for `GET /api/v1/dashboard/results` and
 * `GET /api/v1/dashboard/results/export`. All filters optional. Pagination
 * applies to the list endpoint only; the export streams the full result.
 *
 * Note: `coerce` on numeric query params is applied at the route boundary
 * via `coercedIntegerQuery`; this shared schema keeps the strict-number
 * shape so frontend callers don't accidentally send string values.
 */
export const listResultsQuerySchema = z
  .object({
    campaignId: z.number().int().positive().optional(),
    hashListId: z.number().int().positive().optional(),
    q: z.string().min(1).optional(),
    startDate: z.string().datetime().optional(),
    endDate: z.string().datetime().optional(),
    limit: z.number().int().min(1).max(100).default(50),
    offset: z.number().int().min(0).default(0),
  })
  .openapi('ListResultsQuery')

/**
 * Per-row wire shape for `GET /api/v1/dashboard/results`. `attackModeName`
 * is the resolved display name from `HASHCAT_ATTACK_MODE_NAMES`; the raw
 * `attackMode` integer stays alongside it for scripting/filtering.
 *
 * `crackedAt` is ISO 8601. `Date.prototype.toJSON` emits ISO 8601 by spec,
 * so the route's default Drizzle serialization satisfies this contract;
 * U5 pins it with an explicit assertion.
 */
export const crackedResultRowSchema = z
  .object({
    id: z.number().int(),
    hashValue: z.string(),
    plaintext: z.string().nullable(),
    crackedAt: z.string().datetime().nullable(),
    hashListId: z.number().int(),
    hashListName: z.string(),
    campaignId: z.number().int().nullable(),
    campaignName: z.string().nullable(),
    attackId: z.number().int().nullable(),
    attackMode: z.number().int().nullable(),
    attackModeName: z.string().nullable(),
    agentId: z.number().int().nullable(),
  })
  .openapi('CrackedResultRow')

/**
 * Response shape for `GET /api/v1/dashboard/results`. `total` is the
 * unpaginated count of rows matching the filters; `limit`/`offset` echo
 * the effective pagination after clamping.
 */
export const listResultsResponseSchema = z
  .object({
    results: z.array(crackedResultRowSchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int(),
    offset: z.number().int(),
  })
  .openapi('CrackedResultList')
