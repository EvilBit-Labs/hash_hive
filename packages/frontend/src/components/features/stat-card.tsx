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
 * Visual emphasis for the stat value. `primary` reserves `text-3xl` for the
 * one operator-critical metric per surface (the moment a hash cracks);
 * `secondary` keeps the supporting cards at `text-2xl` so the grid does not
 * read as a uniform 4-card SaaS dashboard. Enum rather than boolean so
 * future levels (`hero`, `tertiary`) land without a breaking prop change.
 */
export type StatEmphasis = 'primary' | 'secondary'

interface StatCardProps {
  readonly title: string
  readonly value: string | number
  readonly subtitle: string
  readonly loading?: boolean
  /** SPA route to navigate to when clicked. Omit for non-interactive card. */
  readonly to?: string
  /** Catppuccin token name (e.g. "--ctp-teal") for the left-border and sparkline stroke. */
  readonly accent?: StatAccent
  /** Recent samples for the embedded sparkline; sparkline renders only when length >= 2. */
  readonly sparkData?: ReadonlyArray<SparkPoint>
  /** Visual emphasis; defaults to `secondary`. Use `primary` for the single hero metric. */
  readonly emphasis?: StatEmphasis
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
}: StatCardProps) {
  const navigate = useNavigate()
  const gradientId = `stat-spark-${useId().replace(/:/g, '')}`
  const accentColor = accent ? `hsl(var(${accent}))` : undefined
  const accentStyle = accent ? { borderLeftColor: accentColor } : undefined
  const hasSparkline = !!sparkData && sparkData.length >= 2 && !loading

  const valueSlot = loading ? (
    <Skeleton className="mt-2 h-8 w-20" />
  ) : (
    <div className="relative mt-2 inline-block" aria-live="polite" aria-atomic="true">
      <AnimatePresence initial={false} mode="sync">
        <motion.span
          key={String(value)}
          initial={ANIMATE_FROM}
          animate={ANIMATE_TO}
          exit={ANIMATE_EXIT}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          className={cn(
            'text-foreground inline-block font-mono font-bold tabular-nums',
            emphasis === 'primary' ? 'text-3xl' : 'text-2xl'
          )}
        >
          {value}
        </motion.span>
      </AnimatePresence>
    </div>
  )

  const sparkStroke = accentColor ?? 'hsl(var(--muted-foreground))'
  const emptySparkline = <div className="mt-3 h-10 w-full" aria-hidden="true" />
  const sparklineSlot = loading ? (
    <Skeleton className="mt-3 h-10 w-full" />
  ) : hasSparkline ? (
    <ChartErrorBoundary fallback={emptySparkline}>
      <div className="mt-3 h-10 w-full" aria-label={`${title} trend, ${sparkData.length} samples`}>
        <ResponsiveContainer width="100%" height={40}>
          <AreaChart
            data={sparkData as SparkPoint[]}
            margin={{ top: 4, right: 0, bottom: 0, left: 0 }}
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={sparkStroke} stopOpacity={0.3} />
                <stop offset="95%" stopColor={sparkStroke} stopOpacity={0} />
              </linearGradient>
            </defs>
            <Area
              type="monotone"
              dataKey="value"
              stroke={sparkStroke}
              strokeWidth={1.5}
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
      <p className="text-muted-foreground text-xs font-medium tracking-wider uppercase">{title}</p>
      {valueSlot}
      <p className="text-muted-foreground mt-0.5 text-xs">{subtitle}</p>
      {sparklineSlot}
    </>
  )

  if (to) {
    return (
      <button
        type="button"
        data-testid="stat-card"
        onClick={() => navigate(to)}
        style={accentStyle}
        className={cn(
          'group bg-surface-0/40 w-full rounded-md border p-4 text-left transition-all',
          accent ? 'border-surface-0 border-l-2' : 'border-surface-0',
          'hover:border-primary/30 hover:bg-surface-0/70 focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none'
        )}
      >
        {content}
      </button>
    )
  }

  return (
    <div
      data-testid="stat-card"
      style={accentStyle}
      className={cn(
        'bg-surface-0/40 rounded-md border p-4',
        accent ? 'border-surface-0 border-l-2' : 'border-surface-0'
      )}
    >
      {content}
    </div>
  )
}
