import type { LucideIcon } from 'lucide-react'

import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useId, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { Area, AreaChart, ResponsiveContainer } from 'recharts'

import type { SparkPoint } from '../../hooks/use-spark-history'

import { cn } from '../../lib/utils'
import { Skeleton } from '../ui/skeleton'
import { ChartErrorBoundary } from './chart-error-boundary'

/**
 * CSS custom-property names for stat-card accent colors. Locked to the
 * Catppuccin Macchiato palette tokens defined in `src/index.css`. New
 * accents must land here so a typo at the call site becomes a TS error,
 * not a silently-invisible sparkline at runtime.
 */
export type StatAccent =
  | '--ctp-teal'
  | '--ctp-lavender'
  | '--ctp-peach'
  | '--info'
  | '--success'
  | '--warning'
  | '--destructive'

/**
 * Visual emphasis for the stat value.
 *
 * `primary` drenches the card in the brand peach surface, scales the value
 * to a hero size, and anchors a corner icon. Reserved for the single
 * operator-moment metric per surface ("the moment a hash cracks" per the
 * project's design context).
 *
 * `secondary` (default) is a flat surveillance card: full border, no
 * decorative stripe, no icon. The accent only carries through the
 * sparkline stroke so the per-domain hue stays ambient rather than
 * shouting at the operator from 2m away.
 */
export type StatEmphasis = 'primary' | 'secondary'

interface StatCardProps {
  readonly title: string
  readonly value: string | number
  readonly subtitle: string
  readonly loading?: boolean
  /** SPA route to navigate to when clicked. Omit for non-interactive card. */
  readonly to?: string
  /** Catppuccin token name (e.g. "--ctp-teal") used for the sparkline stroke + gradient. */
  readonly accent?: StatAccent
  /** Recent samples for the embedded sparkline; sparkline renders only when length >= 2. */
  readonly sparkData?: ReadonlyArray<SparkPoint>
  /** Visual emphasis; defaults to `secondary`. Use `primary` for the single hero metric. */
  readonly emphasis?: StatEmphasis
  /** Optional lucide icon, rendered in the top-right corner. Used by `emphasis="primary"`. */
  readonly icon?: LucideIcon
  /** Extra classes for the outer surface (e.g. `lg:col-span-5` from a bento parent grid). */
  readonly className?: string
  /**
   * Opt-in delight beat: when the numeric `value` increments by a small
   * amount (single-batch range), render a brief `+N` badge floating up
   * from the value and pulse a peach ring around the card surface.
   * Skipped on initial mount, on transitions where either side of the
   * comparison is non-numeric (any loading or unknown sentinel from
   * the caller), and on large jumps (`> CELEBRATE_MAX_DELTA`) that
   * would feel like "+1234" noise rather than a single cracking
   * moment. Default false — only the Cracked hero opts in.
   */
  readonly celebrateOnIncrement?: boolean
}

/**
 * Single-batch ceiling for the delight beat. A hashcat worker may
 * report a handful of cracks per heartbeat; anything larger almost
 * certainly came from a project switch, an initial load, or a bulk
 * import, and "+1234" on a hero card reads as a bug, not a moment.
 */
const CELEBRATE_MAX_DELTA = 20
const CELEBRATE_DURATION_MS = 1_500

const ANIMATE_FROM = { opacity: 0, y: 4 } as const
const ANIMATE_TO = { opacity: 1, y: 0 } as const
const ANIMATE_EXIT = { opacity: 0, y: -4 } as const

export function StatCard({
  title,
  value,
  subtitle,
  loading,
  to,
  accent,
  sparkData,
  emphasis = 'secondary',
  icon: Icon,
  className,
  celebrateOnIncrement = false,
}: StatCardProps) {
  const navigate = useNavigate()
  const gradientId = `stat-spark-${useId().replace(/:/g, '')}`
  const isPrimary = emphasis === 'primary'

  // Track the previous rendered value so we can detect a single-batch
  // increment and fire the delight beat. The ref starts at the initial
  // value so the first render is a no-op (no celebration on mount).
  const previousValueRef = useRef<string | number>(value)
  const [delta, setDelta] = useState<number | null>(null)

  useEffect(() => {
    const previous = previousValueRef.current
    previousValueRef.current = value

    if (!celebrateOnIncrement) return
    // Any non-numeric previous or current value resets the delta
    // (initial mount, loading placeholders, error sentinels, the
    // project-switch refetch window where the caller routes the
    // value through a non-number).
    if (typeof value !== 'number' || typeof previous !== 'number') return

    const diff = value - previous
    if (diff <= 0 || diff > CELEBRATE_MAX_DELTA) return

    setDelta(diff)
    const id = setTimeout(() => setDelta(null), CELEBRATE_DURATION_MS)
    return () => clearTimeout(id)
  }, [value, celebrateOnIncrement])

  // Sparkline stroke: always the per-card accent, even on the primary card
  // (peach), so the trend line carries through visibly.
  const sparkStroke = accent ? `hsl(var(${accent}))` : 'hsl(var(--muted-foreground))'

  const valueSlot = loading ? (
    <Skeleton className={cn('mt-3', isPrimary ? 'h-14 w-32' : 'h-8 w-20')} />
  ) : (
    <div className="relative mt-3 inline-block" aria-live="polite" aria-atomic="true">
      <AnimatePresence initial={false} mode="wait">
        <motion.span
          key={String(value)}
          initial={ANIMATE_FROM}
          animate={ANIMATE_TO}
          exit={ANIMATE_EXIT}
          transition={{ duration: 0.15, ease: 'easeOut' }}
          className={cn(
            'inline-block font-mono leading-none font-bold tabular-nums',
            isPrimary
              ? 'text-5xl tracking-tight text-[hsl(var(--ctp-peach))]'
              : 'text-2xl text-foreground'
          )}
        >
          {value}
        </motion.span>
      </AnimatePresence>
      <AnimatePresence>
        {delta !== null && (
          <motion.span
            data-testid="stat-card-delta-badge"
            key={`delta-${delta}`}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: -28 }}
            exit={{ opacity: 0, y: -40 }}
            transition={{ duration: 1.2, ease: [0.16, 1, 0.3, 1] }}
            className={cn(
              'pointer-events-none absolute top-0 -right-3 translate-x-full',
              'inline-flex items-center rounded-full px-2 py-0.5',
              'font-mono text-xs leading-none font-bold tabular-nums',
              'bg-[hsl(var(--ctp-peach))] text-[hsl(var(--background))]',
              'shadow-[0_4px_12px_hsl(var(--ctp-peach)/0.35)]'
            )}
            aria-hidden="true"
          >
            +{delta}
          </motion.span>
        )}
      </AnimatePresence>
    </div>
  )

  const emptySparkline = <div className="mt-4 h-10 w-full" aria-hidden="true" />
  const hasSparkline = !!sparkData && sparkData.length >= 2 && !loading
  const sparklineSlot = loading ? (
    <Skeleton className="mt-4 h-10 w-full" />
  ) : hasSparkline ? (
    <ChartErrorBoundary fallback={emptySparkline}>
      <div className="mt-4 h-10 w-full" aria-label={`${title} trend, ${sparkData.length} samples`}>
        <ResponsiveContainer width="100%" height={40}>
          <AreaChart
            data={sparkData as SparkPoint[]}
            margin={{ top: 4, right: 0, bottom: 0, left: 0 }}
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={sparkStroke} stopOpacity={isPrimary ? 0.45 : 0.3} />
                <stop offset="95%" stopColor={sparkStroke} stopOpacity={0} />
              </linearGradient>
            </defs>
            <Area
              type="monotone"
              dataKey="value"
              stroke={sparkStroke}
              strokeWidth={isPrimary ? 2 : 1.5}
              fill={`url(#${gradientId})`}
              dot={false}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </ChartErrorBoundary>
  ) : (
    emptySparkline
  )

  // Per-domain accent for the title and corner icon on supporting cards.
  // Editorial-color direction from .impeccable.md: "per-attack-mode colors
  // for chunking" — the accent token carries each supporting card's
  // identity through its title text and corner icon, not as a side
  // stripe or surface drench (the hero Cracked card already owns surface
  // commitment). Falls back to muted-foreground when no accent is set.
  const accentColor = accent ? `hsl(var(${accent}))` : undefined
  const secondaryAccentStyle = accentColor ? { color: accentColor } : undefined

  // Primary content is laid out as a flex column so the title hugs the top
  // and the value + subtitle + sparkline cluster at the bottom of the
  // tall hero card. Secondary keeps its compact stacked rhythm.
  const content = isPrimary ? (
    <>
      {Icon && (
        <Icon
          aria-hidden="true"
          className="absolute top-5 right-5 h-6 w-6 text-[hsl(var(--ctp-peach)/0.7)]"
        />
      )}
      <p className="text-xs font-medium tracking-[0.18em] text-[hsl(var(--ctp-peach)/0.85)] uppercase">
        {title}
      </p>
      <div className="flex flex-col gap-1">
        {valueSlot}
        <p className="text-xs text-[hsl(var(--ctp-peach)/0.65)]">{subtitle}</p>
        {sparklineSlot}
      </div>
    </>
  ) : (
    <>
      {Icon && (
        <Icon
          aria-hidden="true"
          className={cn(
            'absolute top-4 right-4 h-5 w-5',
            accentColor ? '' : 'text-muted-foreground'
          )}
          style={secondaryAccentStyle}
        />
      )}
      <p
        className={cn(
          'text-xs font-medium tracking-[0.18em] uppercase',
          accentColor ? '' : 'text-muted-foreground'
        )}
        style={secondaryAccentStyle}
      >
        {title}
      </p>
      {valueSlot}
      <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>
      {sparklineSlot}
    </>
  )

  // Drenched primary card: peach surface gradient + peach border. Carries
  // ~50% of the card area in peach tint so the hero metric is unmistakable
  // from across the room. `min-h-64` pairs with the adjacent crack-rate
  // trend chart (h-64) on the dashboard bento; the inner `flex-col
  // justify-between` pins the title at the top and the value+sparkline
  // cluster at the bottom of the tall hero card.
  const primarySurface = cn(
    'relative flex flex-col justify-between bg-gradient-to-b from-[hsl(var(--ctp-peach)/0.16)] to-[hsl(var(--ctp-peach)/0.04)]',
    'min-h-64 rounded-md border border-[hsl(var(--ctp-peach)/0.35)] p-6',
    'transition-colors',
    'hover:from-[hsl(var(--ctp-peach)/0.22)] hover:to-[hsl(var(--ctp-peach)/0.06)]',
    'hover:border-[hsl(var(--ctp-peach)/0.55)]',
    'focus-visible:ring-2 focus-visible:ring-[hsl(var(--ctp-peach)/0.6)] focus-visible:outline-none'
  )

  // Supporting card: flat surveillance shell. Full borders only, no
  // side-stripe accent — the per-domain hue carries via the sparkline,
  // not the card chrome.
  const secondarySurface = cn(
    'relative rounded-md border border-surface-0 bg-surface-0/40 p-5',
    'transition-colors',
    'hover:border-surface-1 hover:bg-surface-0/70',
    'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
  )

  const surface = cn(isPrimary ? primarySurface : secondarySurface, className)

  // Surface ring pulse that overlays the card during a celebrated
  // increment. Sits inside the card and stretches to the rounded
  // border so the pulse traces the same shape as the surface itself.
  // `pointer-events-none` keeps the click target on the underlying
  // button. The opacity keyframes mean reduced-motion users still see
  // a brief fade (no Y-movement, no scale) instead of a static ring.
  const ringPulse = (
    <AnimatePresence>
      {delta !== null && (
        <motion.span
          aria-hidden="true"
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 1, 0] }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.9, ease: 'easeOut' }}
          className={cn(
            'pointer-events-none absolute inset-0 rounded-md',
            'ring-2 ring-[hsl(var(--ctp-peach))]'
          )}
        />
      )}
    </AnimatePresence>
  )

  if (to) {
    return (
      <button
        type="button"
        data-testid="stat-card"
        onClick={() => navigate(to)}
        className={cn('group w-full text-left', surface)}
      >
        {content}
        {ringPulse}
      </button>
    )
  }

  return (
    <div data-testid="stat-card" className={surface}>
      {content}
      {ringPulse}
    </div>
  )
}
