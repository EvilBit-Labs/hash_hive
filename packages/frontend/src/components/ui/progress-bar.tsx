import { cn } from '../../lib/utils'
import { Progress } from './progress'

interface BaseProgressBarProps {
  /**
   * Completion ratio. Accepts either the canonical 0-1 scale or the 0-100
   * scale; values above 1 are treated as percentage points. Clamped to
   * [0, 100].
   */
  value: number
  /**
   * `default` is the full detail-page bar; `thin` is the table-row variant.
   */
  size?: 'default' | 'thin'
  /**
   * Override the bar color. Defaults to the primary token.
   */
  tone?: 'primary' | 'success' | 'destructive'
  className?: string
}

/**
 * Discriminated prop union: the component must always have an
 * accessible name. Provide either a visible `label` (rendered below
 * the bar, also used as the ARIA name) or an `ariaLabel` for the
 * screen-reader-only case. Allowing both undefined would leave the
 * `role="progressbar"` element without an accessible name, which fails
 * automated accessibility audits.
 */
type ProgressBarProps =
  | (BaseProgressBarProps & { label: string; ariaLabel?: string })
  | (BaseProgressBarProps & { label?: undefined; ariaLabel: string })

const TONE_INDICATOR_CLASSES = {
  primary: 'bg-primary',
  success: 'bg-success',
  destructive: 'bg-destructive',
} as const

const SIZE_TRACK_CLASSES = {
  default: 'h-2',
  thin: 'h-1.5',
} as const

function normalize(value: number): number {
  if (!Number.isFinite(value)) return 0
  // Treat 0..1 as a fraction; anything above 1 is already a percentage.
  const pct = value <= 1 ? value * 100 : value
  return Math.min(100, Math.max(0, pct))
}

export function ProgressBar({
  value,
  label,
  size = 'default',
  tone = 'primary',
  ariaLabel,
  className,
}: ProgressBarProps) {
  const percentage = normalize(value)

  return (
    <div className={cn('w-full', className)}>
      <Progress
        aria-label={ariaLabel ?? label}
        value={Math.round(percentage)}
        className={cn('rounded-full', SIZE_TRACK_CLASSES[size])}
        indicatorClassName={TONE_INDICATOR_CLASSES[tone]}
      />
      {label && (
        <p className="mt-1 font-mono text-xs text-muted-foreground tabular-nums">{label}</p>
      )}
    </div>
  )
}
