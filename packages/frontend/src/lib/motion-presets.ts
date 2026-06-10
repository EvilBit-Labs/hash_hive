/**
 * Shared motion tokens for the Results surfaces. Pulled out so the
 * curve and the polling cadence have a single source of truth — both
 * appear in multiple files (ResultsTable row pulse, TickingNumber
 * delta, CrackRatePercent milestone, LiveIndicator pulse) and were
 * previously duplicated.
 *
 * The tuple is declared `as const` and typed `readonly [number,
 * number, number, number]` so Motion accepts it directly without
 * needing a per-call `[...EASE]` spread.
 */

/** Confident exponential ease-out (mirrors `--ease-out-expo`). */
export const EASE_OUT_EXPO: readonly [number, number, number, number] = [0.16, 1, 0.3, 1]

/**
 * Polling cadence for the Results surfaces. Shared between
 * `useResults({ refetchInterval })`, the `LiveIndicator` aria-label,
 * and any other surface that needs to render the cadence to the
 * operator.
 */
export const RESULTS_POLL_INTERVAL_MS = 30_000
