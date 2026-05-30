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
