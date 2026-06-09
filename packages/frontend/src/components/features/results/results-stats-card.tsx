interface ResultsStatsCardProps {
  /** Total cracked count for the current scope (hash list or campaign). */
  readonly totalCracked: number
  /**
   * Optional total hash count. When provided we render the rate
   * `cracked / total (X.X%)`; when omitted we render just the cracked
   * count so callers that don't have a denominator handy stay valid.
   */
  readonly totalHashes?: number
}

/**
 * Compact stats tile rendered above the Cracked-results table on the
 * hash list and campaign detail Results views. Pure presentational —
 * never fetches data — so the parent page owns the source query and
 * the polling cadence.
 *
 * Renders `Cracked: {cracked} / {total} ({rate}%)` when `totalHashes`
 * is provided; falls back to `Cracked: {cracked}` otherwise. Guards
 * against divide-by-zero when `totalHashes` is `0` (newly-created hash
 * list with no items yet) by rendering `0.0%`.
 */
export function ResultsStatsCard({ totalCracked, totalHashes }: ResultsStatsCardProps) {
  const crackedLabel = totalCracked.toLocaleString()

  if (totalHashes === undefined) {
    return (
      <div className="rounded-md border border-surface-0 bg-surface-0/40 p-4">
        <p className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
          Cracked
        </p>
        <p className="mt-2 font-mono text-2xl font-bold tabular-nums">{crackedLabel}</p>
      </div>
    )
  }

  const rate = totalHashes === 0 ? 0 : (totalCracked / totalHashes) * 100
  const rateLabel = `${rate.toFixed(1)}%`
  const totalLabel = totalHashes.toLocaleString()

  return (
    <div className="rounded-md border border-surface-0 bg-surface-0/40 p-4">
      <p className="text-xs font-medium tracking-wider text-muted-foreground uppercase">Cracked</p>
      <p className="mt-2 font-mono text-2xl font-bold tabular-nums">
        {crackedLabel} / {totalLabel} ({rateLabel})
      </p>
    </div>
  )
}
