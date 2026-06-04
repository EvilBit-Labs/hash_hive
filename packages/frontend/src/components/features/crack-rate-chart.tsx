import { Activity } from 'lucide-react'
import { useId } from 'react'
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

import { Skeleton } from '../ui/skeleton'

export interface CrackPoint {
  readonly sampledAt: number
  readonly value: number
}

interface CrackRateTrendChartProps {
  readonly data: ReadonlyArray<CrackPoint>
  readonly loading?: boolean
}

interface TooltipPayloadEntry {
  value?: number | string
}

interface CustomTooltipProps {
  active?: boolean
  payload?: TooltipPayloadEntry[]
  label?: number | string
}

function DashboardTooltip({ active, payload }: CustomTooltipProps) {
  if (!active || !payload || payload.length === 0) {
    return null
  }
  const v = payload[0]?.value
  return (
    <div className="bg-surface-0 border-surface-1 rounded-md border px-2 py-1 text-xs">
      <span className="text-ctp-peach font-mono tabular-nums">{v}</span>
      <span className="text-muted-foreground ml-1">cracked</span>
    </div>
  )
}

export function CrackRateTrendChart({ data, loading }: CrackRateTrendChartProps) {
  const headingId = useId()
  const gradientId = `crack-rate-fill-${useId().replace(/:/g, '')}`

  if (loading) {
    return (
      <section
        aria-labelledby={headingId}
        className="bg-surface-0/40 border-surface-0 rounded-md border p-4"
      >
        <h2 id={headingId} className="sr-only">
          Crack rate trend
        </h2>
        <Skeleton className="h-64 w-full" />
      </section>
    )
  }

  if (data.length < 2) {
    return (
      <section
        aria-labelledby={headingId}
        className="bg-surface-0/40 border-surface-0 rounded-md border p-4"
      >
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

  return (
    <section
      aria-labelledby={headingId}
      className="bg-surface-0/40 border-surface-0 rounded-md border p-4"
    >
      <h2 id={headingId} className="sr-only">
        Crack rate trend
      </h2>
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height={256}>
          <AreaChart data={data as CrackPoint[]} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="hsl(var(--ctp-peach))" stopOpacity={0.3} />
                <stop offset="95%" stopColor="hsl(var(--ctp-peach))" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="sampledAt"
              tickLine={false}
              axisLine={false}
              tick={{ fill: 'hsl(var(--ctp-overlay1))', fontSize: 11 }}
              tickFormatter={() => ''}
            />
            <YAxis hide />
            <Tooltip
              content={<DashboardTooltip />}
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
  )
}
