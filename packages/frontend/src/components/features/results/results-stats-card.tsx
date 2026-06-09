import { cn } from '../../../lib/utils'

interface ResultsStatsCardProps {
  /** Total cracked count for the scoped result set. */
  readonly totalCracked: number
  /**
   * Optional hash list size used as the crack-rate denominator. Omit
   * when unknown (e.g. hash list lookup hasn't returned yet) and the
   * card collapses to a single "Cracked: N" figure rather than rendering
   * a misleading 100% rate.
   */
  readonly totalHashes?: number
  /** Optional helper text rendered under the figure (e.g. scope hint). */
  readonly subtitle?: string
  /** Extra classes for the outer surface. */
  readonly className?: string
}

const PERCENT_PRECISION = 1
const PERCENT_FACTOR = 100

function formatNumber(n: number): string {
  return n.toLocaleString('en-US')
}

function computeCrackRate(cracked: number, total: number): string {
  if (total <= 0) return '0.0'
  return ((cracked / total) * PERCENT_FACTOR).toFixed(PERCENT_PRECISION)
}

/**
 * Compact stats card for the cracked-results subview. Renders the total
 * cracked count and (when the hash list size is known) the crack rate as
 * a percentage. Shared by the campaign detail Results tab (U9) and the
 * hash list detail Cracked view (U10) so the two surfaces stay visually
 * coherent.
 *
 * The card never fetches its own data — both `totalCracked` and
 * `totalHashes` come from the call site. This keeps the component
 * trivially reusable from the global Results page if we ever need a
 * compact summary header there.
 *
 * Divide-by-zero guard: when `totalHashes === 0` the rate renders as
 * `0.0%` rather than `NaN%` or `Infinity%` (an empty hash list with zero
 * cracks is the only case this triggers).
 */
export function ResultsStatsCard({
  totalCracked,
  totalHashes,
  subtitle,
  className,
}: ResultsStatsCardProps) {
  const hasTotal = totalHashes !== undefined
  const crackRate = hasTotal ? computeCrackRate(totalCracked, totalHashes) : null

  const figure = hasTotal
    ? `Cracked: ${formatNumber(totalCracked)} / ${formatNumber(totalHashes)} (${crackRate}%)`
    : `Cracked: ${formatNumber(totalCracked)}`

  return (
    <div
      data-testid="results-stats-card"
      className={cn(
        'relative rounded-md border border-surface-0 bg-surface-0/40 p-5',
        'transition-colors hover:border-surface-1 hover:bg-surface-0/70',
        className
      )}
    >
      <p className="text-xs font-medium tracking-[0.18em] text-muted-foreground uppercase">
        Results
      </p>
      <p className="mt-3 font-mono text-2xl leading-none font-bold text-foreground tabular-nums">
        {figure}
      </p>
      {subtitle && <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>}
    </div>
  )
}
