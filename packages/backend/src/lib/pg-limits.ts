/**
 * PostgreSQL column-type limits, shared so validation boundaries agree on
 * one source of truth rather than redeclaring the literal per file.
 */

/**
 * Maximum value of a PostgreSQL `integer` / `serial` (int4) column. Used to
 * bound agent-supplied ids at the validator boundary so an out-of-range
 * value is a clean 400 instead of reaching the column and surfacing as an
 * opaque error. If an id column is ever widened to `bigint`, update here.
 */
export const MAX_PG_INT4 = 2_147_483_647
