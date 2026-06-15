/**
 * Lives here (not in an attacks barrel) to mirror `services/tasks/_internals.ts`:
 * a leaf module with no service imports, so sibling modules like
 * `complexity.ts` can use `jsonSafeBigint` without risking an ESM cycle
 * through a re-exporting barrel. Underscore-prefixed by convention so external
 * consumers don't reach for these utilities.
 */

/**
 * Largest bigint value safely representable as a JS Number without precision
 * loss. Values above this threshold are encoded as decimal strings to preserve
 * precision; values at or below stay Numbers so existing JSON consumers keep
 * working without a string-vs-number branch.
 */
const SAFE_NUMBER_THRESHOLD = BigInt(Number.MAX_SAFE_INTEGER)

/**
 * Pick the JSON representation of a bigint: a JS Number when it fits in JS-safe
 * integer range, otherwise a decimal string. Used for keyspace-derived values
 * (e.g. the progressive ETA) that can overflow Number.MAX_SAFE_INTEGER for
 * mask attacks.
 */
export function jsonSafeBigint(value: bigint): number | string {
  return value <= SAFE_NUMBER_THRESHOLD ? Number(value) : value.toString()
}
