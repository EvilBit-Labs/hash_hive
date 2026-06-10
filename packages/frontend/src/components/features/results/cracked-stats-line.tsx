import { CrackRatePercent } from './crack-rate-percent'
import { TickingNumber } from './ticking-number'

interface CrackedStatsLineProps {
  /** Number of cracked rows in the current scope. */
  readonly cracked: number
  /** Total hashes in the scope (for the denominator + crack rate). Omit when the denominator is unknown. */
  readonly total?: number
}

/**
 * Inline `Cracked N / M (X%)` summary used by both the campaign
 * Results tab and the hash-list Cracked view. The cracked count
 * wraps a `<TickingNumber>` so it acknowledges new cracks; the
 * percentage wraps a `<CrackRatePercent>` so it celebrates the
 * 100% milestone.
 *
 * When `total` is undefined or zero the percentage is omitted —
 * a hash list whose denominator hasn't loaded yet shouldn't
 * render a misleading 100% rate.
 */
export function CrackedStatsLine({ cracked, total }: CrackedStatsLineProps) {
  const hasDenominator = total !== undefined && total > 0
  return (
    <p data-testid="results-stats" className="text-xs text-muted-foreground tabular-nums">
      Cracked{' '}
      <TickingNumber value={cracked} className="font-semibold text-foreground">
        {cracked.toLocaleString('en-US')}
      </TickingNumber>
      {total !== undefined && (
        <>
          {' '}
          / {total.toLocaleString('en-US')}
          {hasDenominator && (
            <>
              {' '}
              <CrackRatePercent value={(cracked / total) * 100} />
            </>
          )}
        </>
      )}
    </p>
  )
}
