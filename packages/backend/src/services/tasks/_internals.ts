/**
 * Lives here to avoid an ESM cycle. Both the parent `services/tasks.ts`
 * (task generation) and sibling `services/tasks/retry.ts` (the stale-
 * task rebalance) need `jsonSafeBigint`; if retry imported it from the
 * parent barrel, the barrel's top-level `export … from './tasks/retry.js'`
 * would form a static import loop and module load order would become
 * load-bearing.
 *
 * Underscore-prefixed by convention so the barrel does not re-export
 * these utilities and external consumers don't reach for them.
 */

/**
 * Largest bigint value safely representable as a JS Number without
 * precision loss. Values above this threshold are encoded as decimal
 * strings to preserve precision; values at or below are encoded as
 * Numbers so existing JSON consumers (the dashboard, the agent's
 * keyspace-range reader) keep working without a string-vs-number branch.
 */
const SAFE_NUMBER_THRESHOLD = BigInt(Number.MAX_SAFE_INTEGER)

/**
 * Pick the JSON representation of a bigint value: a JS Number when the
 * value fits in JS-safe integer range, otherwise a decimal string. Keeps
 * existing `tasks.workRange` consumers (which read fields as numbers)
 * working for realistic-sized attacks while preserving precision for
 * mask keyspaces that overflow Number.MAX_SAFE_INTEGER.
 */
export function jsonSafeBigint(value: bigint): number | string {
  return value <= SAFE_NUMBER_THRESHOLD ? Number(value) : value.toString()
}

/**
 * Read the keyspace-progress value from a task's `progress` jsonb. Accepts
 * either a number or a numeric string (older agents may emit either).
 * Returns 0 for missing / unparseable values so callers treat the task as
 * "fresh" rather than fail noisily. Shared by the stale-task rebalance
 * (`retry.ts`) and the preemption resume pass (`preemption.ts`).
 */
export function readKeyspaceProgress(progress: unknown): bigint {
  if (progress === null || typeof progress !== 'object') return 0n
  return readNonNegativeBigint((progress as Record<string, unknown>)['keyspaceProgress'])
}

/**
 * Read a numeric field from a task's `work_range` jsonb. Accepts either a JS
 * Number (in-safe-range chunks) or a decimal string (mask chunks beyond
 * Number.MAX_SAFE_INTEGER). Returns 0 for missing / unparseable values.
 */
export function readWorkRangeField(workRange: unknown, key: string): bigint {
  if (workRange === null || typeof workRange !== 'object') return 0n
  return readNonNegativeBigint((workRange as Record<string, unknown>)[key])
}

/**
 * Coerce a jsonb keyspace/workRange coordinate to a bigint, accepting ONLY a
 * non-negative safe-integer number or a digit-only string. Everything else —
 * negatives, decimals, unsafe-large numbers (which would lose precision via
 * `Math.floor`), and non-numeric strings — coerces to `0n` so a malformed
 * agent report can't distort the bigint coordinate math (review #221). These
 * coordinates are keyspace offsets, which are always non-negative integers.
 */
function readNonNegativeBigint(raw: unknown): bigint {
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return BigInt(raw)
  if (typeof raw === 'string' && /^[0-9]+$/.test(raw)) return BigInt(raw)
  return 0n
}
