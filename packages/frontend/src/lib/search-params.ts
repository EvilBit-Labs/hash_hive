/**
 * Pure URL search-param parsing utilities shared across browse pages.
 *
 * All helpers are side-effect-free and accept the raw string value returned
 * by `URLSearchParams.get(key)` (null when the key is absent).
 */

/**
 * Parse a positive integer from a search param value.
 * Returns `undefined` when the raw value is absent, non-integer, or <= 0.
 */
export function safePositiveInt(raw: string | null): number | undefined {
  if (!raw) return undefined
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : undefined
}

/**
 * Parse a non-negative integer from a search param value.
 * Returns 0 when the raw value is absent, non-integer, or < 0.
 */
export function safeNonNegativeInt(raw: string | null): number {
  if (!raw) return 0
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : 0
}
