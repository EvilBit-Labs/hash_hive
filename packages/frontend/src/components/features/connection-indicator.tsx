import type { ConnectionStatus } from '@hashhive/shared'
import type { LucideIcon } from 'lucide-react'

import { Activity, WifiOff } from 'lucide-react'

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
      // WS dropped but the 60s polling fallback is still delivering data —
      // operationally degraded, not broken. Distinct from `error`: warning
      // amber + Activity icon + explicit "Polling - 60s" label so a
      // color-blind or glance-reading operator can tell data is
      // fresh-on-poll, not stale (color + icon + label, never color alone).
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
              // Tailwind's animate-ping does not honor prefers-reduced-motion;
              // disable the animation under reduce. system-health-card.tsx
              // uses motion-reduce:hidden for the same gap — both techniques
              // are valid; we prefer keep-the-dot-visible here.
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

interface BannerConfig {
  readonly surface: string
  readonly iconBg: string
  readonly iconColor: string
  readonly titleColor: string
  readonly title: string
  readonly description: string
  readonly Icon: LucideIcon
}

/**
 * Renders an `alert` banner only for the two "operator must know"
 * connection states. `connecting` and its transient siblings produce
 * nothing — they pass too fast to be useful at this surface, and the
 * inline `ConnectionIndicator` already carries the ambient signal.
 */
function bannerForStatus(status: ConnectionStatus): BannerConfig | null {
  switch (status) {
    case 'fallback':
      return {
        surface: 'bg-warning/10 border-warning/30',
        iconBg: 'bg-warning/15',
        iconColor: 'text-warning',
        titleColor: 'text-warning',
        title: 'Live updates paused',
        description:
          'WebSocket connection dropped. Falling back to 60-second polling; data may be up to 60s stale.',
        Icon: Activity,
      }
    case 'error':
      return {
        surface: 'bg-destructive/10 border-destructive/30',
        iconBg: 'bg-destructive/15',
        iconColor: 'text-destructive',
        titleColor: 'text-destructive',
        title: 'Disconnected from the backend',
        description:
          'Live and polled updates have stopped. Recent data may be stale until the connection recovers.',
        Icon: WifiOff,
      }
    case 'open':
    case 'connecting':
    case 'authenticating':
    case 'reconnecting':
      return null
  }
}

interface ConnectionBannerProps {
  /**
   * When provided, the banner renders for this status directly (used
   * by tests). When omitted, reads from `useEventsConnection()`.
   */
  readonly status?: ConnectionStatus
}

/**
 * "Impossible to miss" full-width alert for degraded / disconnected
 * states, mounted at the AppLayout root. Operators on a wall display
 * notice this within one glance — the inline `ConnectionIndicator` is
 * for ambient awareness, this is for action signals.
 *
 * `Reload page` is the explicit operator verb because the underlying
 * `useEvents` hook already auto-retries with backoff; a fresh page
 * load forces a clean BetterAuth handshake + new WebSocket attempt and
 * is what most operators want at this point ("I lost connection;
 * confirm the system is fully back"). A softer in-place `reconnect()`
 * would need to be added to `useEvents` and surfaced through the
 * `EventsContext`; deferred until there's evidence operators want it.
 */
export function ConnectionBanner({ status }: ConnectionBannerProps = {}) {
  const ctx = useEventsConnection()
  const resolved = status ?? ctx.status
  const config = bannerForStatus(resolved)
  if (!config) return null

  const { surface, iconBg, iconColor, titleColor, title, description, Icon } = config

  return (
    <div
      role="alert"
      aria-live="assertive"
      data-testid="connection-banner"
      className={cn(
        'border-b px-4 py-3 sm:px-6 lg:px-8',
        // Transition the color tokens, not layout properties, so an
        // entering banner doesn't reflow the main scroll position.
        'transition-colors',
        surface
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
        <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-md', iconBg)}>
          <Icon aria-hidden="true" className={cn('h-5 w-5', iconColor)} />
        </div>
        <div className="min-w-0 flex-1">
          <p className={cn('text-sm font-semibold', titleColor)}>{title}</p>
          <p className="text-xs text-foreground/80">{description}</p>
        </div>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className={cn(
            'inline-flex h-9 shrink-0 items-center justify-center rounded-md border px-4 text-xs font-medium',
            'border-foreground/25 text-foreground transition-colors',
            'hover:border-foreground/40 hover:bg-foreground/5',
            'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
          )}
        >
          Reload page
        </button>
      </div>
    </div>
  )
}
