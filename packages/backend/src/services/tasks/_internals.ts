/**
 * Tiny shared helpers used by multiple files in the `services/tasks/`
 * cluster (parent `services/tasks.ts` for task generation; sibling
 * `services/tasks/retry.ts` for the stale-task rebalance). Lives here so
 * the two callers can import the same definition without forming an
 * ESM cycle through `services/tasks.ts` (which re-exports from the
 * sibling submodules — a static import from a sibling back to the
 * parent barrel would make the load order load-bearing).
 *
 * Underscore-prefixed by convention so the barrel does not re-export it
 * and external consumers don't reach for these private utilities.
 */

/**
 * Largest bigint value safely representable as a JS Number without
 * precision loss. Values above this threshold are encoded as decimal
 * strings to preserve precision; values at or below are encoded as
 * Numbers so existing JSON consumers (the dashboard, the agent's
 * keyspace-range reader) keep working without a string-vs-number branch.
 */
export const SAFE_NUMBER_THRESHOLD = BigInt(Number.MAX_SAFE_INTEGER)

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
