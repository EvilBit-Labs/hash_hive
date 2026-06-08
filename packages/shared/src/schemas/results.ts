import '../openapi-extension.js'
import { z } from 'zod'

/**
 * Hashcat attack-mode lookup. Maps the integer `mode` value the hashcat
 * agent reports (and the `attacks.mode` column carries) to a human-readable
 * display name. Stable across hashcat 5/6/7 — modes are part of the public
 * CLI contract.
 *
 * Typed as `Partial<Record<number, string>>` via the `satisfies` clause so
 * the runtime invariant ("unknown numeric keys return undefined") is
 * reflected in the type system — without this, lookup expressions would
 * type as `string` and the `?? null` fallback would read as dead code.
 */
export const HASHCAT_ATTACK_MODE_NAMES = {
  0: 'Dictionary',
  1: 'Combination',
  3: 'Mask',
  6: 'Hybrid Wordlist + Mask',
  7: 'Hybrid Mask + Wordlist',
  9: 'Association',
} as const satisfies Readonly<Partial<Record<number, string>>>

// Single source of truth: `AttackModeName` is derived from the map's
// value types, and the runtime tuple is computed via `Object.values`.
// Adding/renaming a mode in `HASHCAT_ATTACK_MODE_NAMES` propagates to
// both the type and the Zod enum below with no parallel literal list.
export type AttackModeName =
  (typeof HASHCAT_ATTACK_MODE_NAMES)[keyof typeof HASHCAT_ATTACK_MODE_NAMES]

const ATTACK_MODE_NAME_VALUES = Object.values(HASHCAT_ATTACK_MODE_NAMES) as [
  AttackModeName,
  ...AttackModeName[],
]

/**
 * Resolve a hashcat attack-mode integer to its display name. Returns `null`
 * for unknown modes (forward compatibility — hashcat occasionally adds
 * modes and dashboards on older builds shouldn't crash) and for `null`
 * input.
 */
export function resolveAttackModeName(mode: number | null): AttackModeName | null {
  if (mode === null) return null
  return HASHCAT_ATTACK_MODE_NAMES[mode as keyof typeof HASHCAT_ATTACK_MODE_NAMES] ?? null
}

/**
 * Per-row wire shape for `GET /api/v1/dashboard/results`. `attackModeName`
 * is the resolved display name from `HASHCAT_ATTACK_MODE_NAMES`; the raw
 * `attackMode` integer stays alongside it for scripting/filtering.
 *
 * `crackedAt` is ISO 8601. `Date.prototype.toJSON` emits ISO 8601 by spec,
 * so the route's default Drizzle serialization satisfies this contract.
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
    attackModeName: z.enum(ATTACK_MODE_NAME_VALUES).nullable(),
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
