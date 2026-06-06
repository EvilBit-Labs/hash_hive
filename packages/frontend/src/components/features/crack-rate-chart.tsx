import { Activity } from 'lucide-react'
import { useId } from 'react'
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  type TooltipContentProps,
  XAxis,
  YAxis,
} from 'recharts'

import type { SparkPoint } from '../../hooks/use-spark-history'

import { cn } from '../../lib/utils'
import { Skeleton } from '../ui/skeleton'
import { ChartErrorBoundary } from './chart-error-boundary'

interface CrackRateTrendChartProps {
  readonly data: ReadonlyArray<SparkPoint>
  readonly loading?: boolean
  /** Extra classes for the rendered <section> (e.g. `lg:col-span-7` from a bento parent grid). */
  readonly className?: string
}

export function DashboardTooltip({ active, payload }: TooltipContentProps) {
  if (!active || !payload || payload.length === 0) {
    return null
  }
  const raw = payload[0]?.value
  // Recharts payload values are typed `number | string | undefined` because
  // a chart can also bind to a categorical axis. Guard non-finite so a
  // malformed point never renders `NaN cracked` silently.
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return null
  }
  return (
    <div className="bg-surface-0 border-surface-1 rounded-md border px-2 py-1 text-xs">
      <span className="text-ctp-peach font-mono tabular-nums">{raw}</span>
      <span className="text-muted-foreground ml-1">cracked</span>
    </div>
  )
}

/** Format a monotonic-ms delta as a compact elapsed label (`0s` / `45s` / `2m`). */
function formatElapsedFromFirst(sampledAtMs: number, firstSampledAtMs: number): string {
  const elapsedSec = Math.max(0, Math.round((sampledAtMs - firstSampledAtMs) / 1000))
  if (elapsedSec < 60) return `${elapsedSec}s`
  const minutes = Math.floor(elapsedSec / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h`
}

export function CrackRateTrendChart({ data, loading, className }: CrackRateTrendChartProps) {
  const headingId = useId()
  const gradientId = `crack-rate-fill-${useId().replace(/:/g, '')}`
  const sectionClass = cn('bg-surface-0/40 border-surface-0 rounded-md border p-4', className)

  if (loading) {
    return (
      <section aria-labelledby={headingId} className={sectionClass}>
        <h2 id={headingId} className="sr-only">
          Crack rate trend
        </h2>
        <Skeleton className="h-64 w-full" />
      </section>
    )
  }

  if (data.length < 2) {
    return (
      <section aria-labelledby={headingId} className={sectionClass}>
        <h2 id={headingId} className="sr-only">
          Crack rate trend
        </h2>
        <output className="flex h-64 w-full flex-col items-center justify-center gap-2">
          <Activity className="text-ctp-overlay0 h-6 w-6" aria-hidden="true" />
          <p className="text-ctp-overlay1 text-sm">No cracks yet in this session</p>
        </output>
      </section>
    )
  }

  const errorFallback = (
    <section aria-labelledby={headingId} className={sectionClass}>
      <h2 id={headingId} className="sr-only">
        Crack rate trend
      </h2>
      <output className="flex h-64 w-full flex-col items-center justify-center gap-2">
        <Activity className="text-ctp-overlay0 h-6 w-6" aria-hidden="true" />
        <p className="text-ctp-overlay1 text-sm">Chart unavailable</p>
      </output>
    </section>
  )

  // Elapsed-time anchor for the X axis. We render `sampledAtMs - first` as
  // "0s" / "45s" / "2m" so operators see how recent each sample is without
  // implying wall-clock time (`sampledAtMs` is `performance.now()`-domain,
  // not Unix epoch). `data.length >= 2` is guaranteed by the early returns
  // above so `data[0]` is always defined here.
  const firstSampledAtMs = data[0]!.sampledAtMs as number

  return (
    <ChartErrorBoundary fallback={errorFallback} resetKey={data.length}>
      <section aria-labelledby={headingId} className={sectionClass}>
        <h2 id={headingId} className="sr-only">
          Crack rate trend
        </h2>
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height={256}>
            <AreaChart
              data={data as SparkPoint[]}
              margin={{ top: 8, right: 8, bottom: 8, left: 8 }}
            >
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="hsl(var(--ctp-peach))" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="hsl(var(--ctp-peach))" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis
                dataKey="sampledAtMs"
                tickLine={false}
                axisLine={false}
                tick={{ fill: 'hsl(var(--ctp-overlay1))', fontSize: 11 }}
                tickFormatter={(ms: number) => formatElapsedFromFirst(ms, firstSampledAtMs)}
              />
              <YAxis hide />
              <Tooltip
                content={DashboardTooltip}
                cursor={{ stroke: 'hsl(var(--ctp-surface2))', strokeWidth: 1 }}
              />
              <Area
                type="monotone"
                dataKey="value"
                stroke="hsl(var(--ctp-peach))"
                strokeWidth={2}
                fill={`url(#${gradientId})`}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </section>
    </ChartErrorBoundary>
  )
}
