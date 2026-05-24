/**
 * System health card (issue #109).
 *
 * Renders the four-component health snapshot (database, redis, minio,
 * queues) with status dots and per-component messages on degraded /
 * unhealthy. Click a row to expand its raw `detail` payload.
 *
 * Aria: aggregate status uses role="status" + aria-live="polite" so
 * screen readers announce changes. The aggregate status dot pulses
 * when the system is degraded or unhealthy (signals "needs attention").
 * Pulse animation is suppressed via `motion-reduce:hidden` when the
 * user has `prefers-reduced-motion` set.
 */
import { useState } from 'react'

import {
  type ComponentHealth,
  type ComponentName,
  type ComponentStatus,
  useSystemHealth,
} from '../../hooks/use-system-health'
import { cn } from '../../lib/utils'

const COMPONENT_LABELS: Record<ComponentName, string> = {
  database: 'Database',
  redis: 'Redis',
  minio: 'Object Storage',
  queues: 'Job Queues',
}

const COMPONENT_ORDER: ComponentName[] = ['database', 'redis', 'minio', 'queues']

const STATUS_DOT: Record<ComponentStatus, string> = {
  healthy: 'bg-success',
  degraded: 'bg-warning',
  unhealthy: 'bg-destructive',
}

const AGGREGATE_LABEL: Record<ComponentStatus, string> = {
  healthy: 'All systems healthy',
  degraded: 'Degraded',
  unhealthy: 'Unhealthy',
}

/**
 * Renders an error from an unknown reject value. Plain-string and
 * plain-object rejections (from custom fetch wrappers) need a fallback
 * description so the user sees something more actionable than a bare
 * "Failed to load system health". The property access is wrapped in
 * try/catch because adversarial inputs may define `message` as a getter
 * that throws — we never want describeError to itself throw during
 * render and blank the card.
 */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  if (err && typeof err === 'object' && 'message' in err) {
    try {
      const msg = (err as { message: unknown }).message
      if (typeof msg === 'string') return msg
    } catch {
      // Fall through: getter threw, treat as unknown.
    }
  }
  return 'unknown error'
}

interface StatusDotProps {
  status: ComponentStatus
  pulse?: boolean
}

function StatusDot({ status, pulse = false }: StatusDotProps) {
  return (
    <span className="relative flex h-2.5 w-2.5 shrink-0" aria-hidden="true">
      {pulse &&
        status !== 'healthy' && (
          // motion-reduce:hidden honors prefers-reduced-motion via Tailwind.
          <span
            className={cn(
              'absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 motion-reduce:hidden',
              STATUS_DOT[status]
            )}
          />
        )}
      <span className={cn('relative inline-flex h-2.5 w-2.5 rounded-full', STATUS_DOT[status])} />
    </span>
  )
}

interface ComponentRowProps {
  name: ComponentName
  health: ComponentHealth
}

function ComponentRow({ name, health }: ComponentRowProps) {
  const [expanded, setExpanded] = useState(false)
  const hasDetail = !!health.detail && Object.keys(health.detail).length > 0
  const showMessage = health.status !== 'healthy' && !!health.message

  const rowContent = (
    <div className="flex items-center gap-3">
      <StatusDot status={health.status} />
      <span className="text-foreground text-sm font-medium">{COMPONENT_LABELS[name]}</span>
      <span className="text-muted-foreground ml-auto font-mono text-xs tracking-wider uppercase">
        {health.status}
      </span>
    </div>
  )

  return (
    <div className="border-surface-0 border-b last:border-b-0">
      {hasDetail ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={`${COMPONENT_LABELS[name]} status: ${health.status}. Click to ${expanded ? 'hide' : 'show'} details.`}
          className="hover:bg-surface-0/40 focus-visible:ring-ring block w-full px-3 py-2 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none"
        >
          {rowContent}
        </button>
      ) : (
        // No detail to expand → static row. The visible label + status
        // text inside `rowContent` is sufficient for screen readers; an
        // additional aria-label on a div is rejected by lint anyway.
        <div className="block w-full px-3 py-2">{rowContent}</div>
      )}
      {showMessage && <p className="text-muted-foreground px-3 pb-2 text-xs">{health.message}</p>}
      {expanded && hasDetail && (
        <pre className="border-surface-0 bg-surface-0/30 text-muted-foreground overflow-x-auto border-t px-3 py-2 font-mono text-xs">
          {JSON.stringify(health.detail, null, 2)}
        </pre>
      )}
    </div>
  )
}

interface SkeletonRowProps {
  label: string
}

function SkeletonRow({ label }: SkeletonRowProps) {
  return (
    <div className="border-surface-0 flex items-center gap-3 border-b px-3 py-2 last:border-b-0">
      <span className="bg-surface-0 h-2.5 w-2.5 shrink-0 rounded-full" aria-hidden="true" />
      <span className="text-muted-foreground text-sm font-medium">{label}</span>
      <span className="text-muted-foreground ml-auto font-mono text-xs tracking-wider uppercase">
        --
      </span>
    </div>
  )
}

export function SystemHealthCard() {
  const { data, isLoading, isError, error } = useSystemHealth()

  return (
    <section
      className="border-surface-0 bg-surface-0/40 rounded-md border"
      aria-labelledby="system-health-title"
    >
      <header className="border-surface-0 flex items-center justify-between border-b px-3 py-2">
        <h2
          id="system-health-title"
          className="text-muted-foreground text-xs font-medium tracking-wider uppercase"
        >
          System Health
        </h2>
        {data ? (
          <div
            className="flex items-center gap-2"
            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- live region is not form output; <output> implies form association we don't have
            role="status"
            aria-live="polite"
            aria-label={`System status: ${AGGREGATE_LABEL[data.status]}`}
          >
            <StatusDot status={data.status} pulse />
            <span className="text-foreground text-xs font-medium">
              {AGGREGATE_LABEL[data.status]}
            </span>
          </div>
        ) : (
          <span className="text-muted-foreground text-xs">--</span>
        )}
      </header>

      {isError && (
        <div
          role="alert"
          className="border-destructive/20 bg-destructive/5 text-destructive border-b px-3 py-2 text-xs"
        >
          Failed to load system health: {describeError(error)}
        </div>
      )}

      <div>
        {isLoading || !data
          ? COMPONENT_ORDER.map((name) => <SkeletonRow key={name} label={COMPONENT_LABELS[name]} />)
          : COMPONENT_ORDER.map((name) => {
              // Record<ComponentName, ComponentHealth> returns
              // ComponentHealth | undefined under noUncheckedIndexedAccess;
              // skip the row instead of crashing if the backend ever
              // omits a component (defensive — current contract requires
              // all four).
              const health = data.components[name]
              if (!health) return null
              return <ComponentRow key={name} name={name} health={health} />
            })}
      </div>
    </section>
  )
}
