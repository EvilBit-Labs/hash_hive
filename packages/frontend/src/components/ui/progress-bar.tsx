import { cn } from '../../lib/utils';

interface ProgressBarProps {
  /**
   * Completion ratio. Accepts either the canonical 0-1 scale or the 0-100
   * scale; values above 1 are treated as percentage points. Clamped to
   * [0, 100].
   */
  value: number;
  /**
   * Optional label rendered below the bar. When omitted, the bar shows
   * only the visual indicator (`aria-label` should be supplied by the
   * parent in that case).
   */
  label?: string;
  /**
   * `default` is the full detail-page bar; `thin` is the table-row variant.
   */
  size?: 'default' | 'thin';
  /**
   * Override the bar color. Defaults to the primary token.
   */
  tone?: 'primary' | 'success' | 'destructive';
  /** Accessible label when no visible `label` is provided. */
  ariaLabel?: string;
  className?: string;
}

const TONE_CLASSES = {
  primary: 'bg-primary',
  success: 'bg-success',
  destructive: 'bg-destructive',
} as const;

function normalize(value: number): number {
  if (!Number.isFinite(value)) return 0;
  // Treat 0..1 as a fraction; anything above 1 is already a percentage.
  const pct = value <= 1 ? value * 100 : value;
  return Math.min(100, Math.max(0, pct));
}

export function ProgressBar({
  value,
  label,
  size = 'default',
  tone = 'primary',
  ariaLabel,
  className,
}: ProgressBarProps) {
  const percentage = normalize(value);
  const trackHeight = size === 'thin' ? 'h-1.5' : 'h-2';

  return (
    <div className={cn('w-full', className)}>
      <div
        role="progressbar"
        aria-valuenow={Math.round(percentage)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={ariaLabel ?? label}
        className={cn('w-full rounded-full bg-surface-1', trackHeight)}
      >
        <div
          className={cn('h-full rounded-full transition-all', TONE_CLASSES[tone])}
          style={{ width: `${percentage}%` }}
        />
      </div>
      {label && (
        <p className="mt-1 font-mono text-xs tabular-nums text-muted-foreground">{label}</p>
      )}
    </div>
  );
}
