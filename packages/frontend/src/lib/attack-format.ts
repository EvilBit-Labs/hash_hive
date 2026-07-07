import { formatDuration } from './duration'

const SECONDS_PER_YEAR = 31_536_000

/**
 * Format an attack's total keyspace (a decimal string that may exceed 2^53) for
 * the attack table: grouped digits below a million, scientific notation above.
 * Returns null for a null/unparseable keyspace so the caller chooses the right
 * empty state; the exact value belongs in the cell's `title`.
 */
export function formatAttackKeyspace(keyspace: string | null): string | null {
  if (keyspace === null) return null
  const n = Number(keyspace)
  if (!Number.isFinite(n)) return keyspace
  if (n < 1_000_000) return n.toLocaleString()
  return n.toExponential(2)
}

/**
 * Format an attack's ETA (seconds remaining; the bigint-safe `number | string`
 * union) as a compact, counting-down duration. Astronomical estimates — a slow
 * mask attack can exceed a year — clamp to `> 1 year` rather than printing a
 * huge number. Returns null when uncomputable so the caller renders the
 * no-estimate state.
 */
export function formatAttackEta(seconds: number | string | null): string | null {
  if (seconds === null) return null
  const s = Number(seconds)
  if (!Number.isFinite(s) || s < 0) return null
  if (s === 0) return '0s'
  if (s > SECONDS_PER_YEAR) return '> 1 year'
  return formatDuration(s)
}
