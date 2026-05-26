import type { ConnectionStatus } from '@hashhive/shared'

import { cn } from '../../lib/utils'
import { useEventsConnection } from './events-provider'

interface VisualState {
  dotClass: string
  labelClass: string
  pulse: boolean
  ariaLabel: string
  text: string
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
      return {
        dotClass: 'bg-destructive',
        labelClass: 'text-destructive',
        pulse: false,
        ariaLabel: 'Offline — polling',
        text: 'Offline — polling',
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
              'absolute inline-flex h-full w-full animate-ping rounded-full opacity-50'
            )}
          />
        )}
        <span className={cn('relative inline-flex h-2 w-2 rounded-full', v.dotClass)} />
      </span>
      <span className={v.labelClass}>{v.text}</span>
    </output>
  )
}
