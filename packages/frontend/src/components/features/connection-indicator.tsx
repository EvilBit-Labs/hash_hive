import type { ConnectionStatus } from '@hashhive/shared'

import { Activity } from 'lucide-react'

import { cn } from '../../lib/utils'
import { useEventsConnection } from './events-provider'

interface VisualState {
  dotClass: string
  labelClass: string
  pulse: boolean
  ariaLabel: string
  text: string
  showFallbackIcon?: boolean
}

/**
 * Maps the six-state ConnectionStatus union to the indicator's three
 * visual buckets. Kept exhaustive so future status additions surface
 * as TS errors here rather than as a silent default render.
 */
function visualForStatus(status: ConnectionStatus): VisualState {
  switch (status) {
    case 'open':
      return {
        dotClass: 'bg-success',
        labelClass: 'text-success',
        pulse: true,
        ariaLabel: 'Live',
        text: 'Live',
      }
    case 'connecting':
    case 'authenticating':
    case 'reconnecting':
      return {
        dotClass: 'bg-warning',
        labelClass: 'text-warning',
        pulse: false,
        ariaLabel: 'Reconnecting',
        text: 'Reconnecting...',
      }
    case 'fallback':
      // WS dropped but polling fallback is active — operationally degraded,
      // not broken. Distinct visual + label from `error` per R14 / Principle 3.
      return {
        dotClass: 'bg-warning',
        labelClass: 'text-warning',
        pulse: false,
        ariaLabel: 'Polling - 60s',
        text: 'Polling - 60s',
        showFallbackIcon: true,
      }
    case 'error':
      return {
        dotClass: 'bg-destructive',
        labelClass: 'text-destructive',
        pulse: false,
        ariaLabel: 'Disconnected',
        text: 'Disconnected',
      }
  }
}

interface ConnectionIndicatorProps {
  /**
   * When provided, the indicator renders for this status directly
   * (useful for tests and one-off renders). When omitted, it reads
   * from the `EventsProvider` context via `useEventsConnection()`.
   */
  status?: ConnectionStatus
}

export function ConnectionIndicator({ status }: ConnectionIndicatorProps = {}) {
  const ctx = useEventsConnection()
  const resolved = status ?? ctx.status
  const v = visualForStatus(resolved)

  return (
    <output className="flex items-center gap-2 text-xs" aria-live="polite" aria-label={v.ariaLabel}>
      <span className="relative flex h-2 w-2">
        {v.pulse && (
          <span
            className={cn(
              v.dotClass,
              'absolute inline-flex h-full w-full animate-ping rounded-full opacity-50',
              // Tailwind's animate-ping does not honor prefers-reduced-motion
              // automatically — gate explicitly per the system-health-card precedent.
              'motion-reduce:animate-none'
            )}
          />
        )}
        <span className={cn('relative inline-flex h-2 w-2 rounded-full', v.dotClass)} />
      </span>
      {v.showFallbackIcon && (
        <Activity
          data-testid="connection-fallback-icon"
          aria-hidden="true"
          className={cn('h-3 w-3', v.labelClass)}
        />
      )}
      <span className={v.labelClass}>{v.text}</span>
    </output>
  )
}
