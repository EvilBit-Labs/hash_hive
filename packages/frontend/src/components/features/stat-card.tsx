import type { LucideIcon } from 'lucide-react'

import { AnimatePresence, motion } from 'motion/react'
import { useId } from 'react'
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
}

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
}: StatCardProps) {
  const navigate = useNavigate()
  const gradientId = `stat-spark-${useId().replace(/:/g, '')}`
  const isPrimary = emphasis === 'primary'

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
              : 'text-foreground text-2xl'
          )}
        >
          {value}
        </motion.span>
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

  const content = (
    <>
      {Icon && (
        <Icon
          aria-hidden="true"
          className={cn(
            'absolute top-4 right-4 h-5 w-5',
            isPrimary ? 'text-[hsl(var(--ctp-peach)/0.7)]' : 'text-muted-foreground'
          )}
        />
      )}
      <p
        className={cn(
          'text-xs font-medium tracking-[0.18em] uppercase',
          isPrimary ? 'text-[hsl(var(--ctp-peach)/0.85)]' : 'text-muted-foreground'
        )}
      >
        {title}
      </p>
      {valueSlot}
      <p
        className={cn(
          'mt-1 text-xs',
          isPrimary ? 'text-[hsl(var(--ctp-peach)/0.65)]' : 'text-muted-foreground'
        )}
      >
        {subtitle}
      </p>
      {sparklineSlot}
    </>
  )

  // Drenched primary card: peach surface gradient + peach border. Carries
  // ~50% of the card area in peach tint so the hero metric is unmistakable
  // from across the room. Supporting cards stay neutral so this one card
  // doesn't have to compete for attention.
  const primarySurface = cn(
    'relative bg-gradient-to-b from-[hsl(var(--ctp-peach)/0.16)] to-[hsl(var(--ctp-peach)/0.04)]',
    'rounded-md border border-[hsl(var(--ctp-peach)/0.35)] p-5',
    'transition-colors',
    'hover:from-[hsl(var(--ctp-peach)/0.22)] hover:to-[hsl(var(--ctp-peach)/0.06)]',
    'hover:border-[hsl(var(--ctp-peach)/0.55)]',
    'focus-visible:ring-2 focus-visible:ring-[hsl(var(--ctp-peach)/0.6)] focus-visible:outline-none'
  )

  // Supporting card: flat surveillance shell. Full borders only, no
  // side-stripe accent — the per-domain hue carries via the sparkline,
  // not the card chrome.
  const secondarySurface = cn(
    'bg-surface-0/40 border-surface-0 relative rounded-md border p-5',
    'transition-colors',
    'hover:bg-surface-0/70 hover:border-surface-1',
    'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none'
  )

  const surface = isPrimary ? primarySurface : secondarySurface

  if (to) {
    return (
      <button
        type="button"
        data-testid="stat-card"
        onClick={() => navigate(to)}
        className={cn('group w-full text-left', surface)}
      >
        {content}
      </button>
    )
  }

  return (
    <div data-testid="stat-card" className={surface}>
      {content}
    </div>
  )
}
