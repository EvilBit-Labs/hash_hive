import type { ConnectionStatus } from '@hashhive/shared'

import { afterEach, describe, expect, it } from 'bun:test'

import {
  ConnectionBanner,
  ConnectionIndicator,
} from '../../src/components/features/connection-indicator'
import { cleanupAll, fireEvent, renderWithProviders, screen } from '../test-utils'

afterEach(cleanupAll)

describe('ConnectionIndicator', () => {
  it('shows "Live" with green dot and a motion-reduce-gated ping when status is open', () => {
    renderWithProviders(<ConnectionIndicator status="open" />)

    expect(screen.getByText('Live')).toBeDefined()
    expect(document.querySelector('.bg-success')).not.toBeNull()
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('Live')

    const ping = document.querySelector('.animate-ping')
    expect(ping).not.toBeNull()
    // R9: Tailwind's animate-ping does not respect prefers-reduced-motion by default —
    // the gate must be wired explicitly per the system-health-card.tsx precedent.
    expect(ping?.className).toContain('motion-reduce:animate-none')
  })

  it('shows "Reconnecting..." with warning dot for connecting status', () => {
    renderWithProviders(<ConnectionIndicator status="connecting" />)

    expect(screen.getByText('Reconnecting...')).toBeDefined()
    expect(document.querySelector('.bg-warning')).not.toBeNull()
  })

  it('shows "Reconnecting..." with warning dot for authenticating status', () => {
    renderWithProviders(<ConnectionIndicator status="authenticating" />)

    expect(screen.getByText('Reconnecting...')).toBeDefined()
    expect(document.querySelector('.bg-warning')).not.toBeNull()
  })

  it('shows "Reconnecting..." with warning dot for reconnecting status', () => {
    renderWithProviders(<ConnectionIndicator status="reconnecting" />)

    expect(screen.getByText('Reconnecting...')).toBeDefined()
    expect(document.querySelector('.bg-warning')).not.toBeNull()
  })

  it('renders fallback state with warning color, Activity icon, and "Polling - 60s" label', () => {
    renderWithProviders(<ConnectionIndicator status="fallback" />)

    // Distinct from error: WS dropped but the 60s polling fallback is still
    // delivering data. Assert the literal label so drift to "Polling..." or
    // "Offline - polling" fails the test.
    expect(screen.getByText('Polling - 60s')).toBeDefined()
    // Warning color, NOT destructive
    expect(document.querySelector('.bg-warning')).not.toBeNull()
    expect(document.querySelector('.bg-destructive')).toBeNull()
    // Non-color cue per Principle 3
    expect(document.querySelector('[data-testid="connection-fallback-icon"]')).not.toBeNull()
    // No ping in fallback — system is degraded, not live
    expect(document.querySelector('.animate-ping')).toBeNull()
  })

  it('shows "Disconnected" with destructive dot for error status (no fallback icon)', () => {
    renderWithProviders(<ConnectionIndicator status="error" />)

    expect(screen.getByText('Disconnected')).toBeDefined()
    expect(document.querySelector('.bg-destructive')).not.toBeNull()
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('Disconnected')
    expect(document.querySelector('[data-testid="connection-fallback-icon"]')).toBeNull()
  })

  it('renders the disconnected default when used outside EventsProvider', () => {
    // No `status` prop and no EventsProvider — useEventsConnection() returns
    // its fallback snapshot (status === 'connecting').
    renderWithProviders(<ConnectionIndicator />)
    expect(screen.getByText('Reconnecting...')).toBeDefined()
  })

  it('renders a stable output element across all four visual buckets', () => {
    const buckets: ConnectionStatus[] = ['open', 'reconnecting', 'fallback', 'error']
    for (const status of buckets) {
      cleanupAll()
      renderWithProviders(<ConnectionIndicator status={status} />)
      const root = document.querySelector('output')
      expect(root).not.toBeNull()
    }
  })
})

describe('ConnectionBanner', () => {
  it('renders nothing for the open state', () => {
    renderWithProviders(<ConnectionBanner status="open" />)
    expect(screen.queryByTestId('connection-banner')).toBeNull()
  })

  it.each(['connecting', 'reconnecting', 'authenticating'] as const)(
    'renders nothing for the transient %s state',
    (status) => {
      renderWithProviders(<ConnectionBanner status={status} />)
      expect(screen.queryByTestId('connection-banner')).toBeNull()
    }
  )

  it('renders the amber fallback banner with the Activity-style copy and an Polling-shape title', () => {
    renderWithProviders(<ConnectionBanner status="fallback" />)
    const banner = screen.getByTestId('connection-banner')
    expect(banner.getAttribute('role')).toBe('alert')
    expect(banner.getAttribute('aria-live')).toBe('assertive')
    expect(banner.className).toContain('bg-warning/10')
    expect(screen.getByText('Live updates paused')).toBeDefined()
    expect(screen.getByText(/WebSocket connection dropped/i)).toBeDefined()
    expect(screen.getByRole('button', { name: 'Reload page' })).toBeDefined()
  })

  it('renders the red error banner with the WifiOff-shape copy and assertive aria-live', () => {
    renderWithProviders(<ConnectionBanner status="error" />)
    const banner = screen.getByTestId('connection-banner')
    expect(banner.getAttribute('role')).toBe('alert')
    expect(banner.getAttribute('aria-live')).toBe('assertive')
    expect(banner.className).toContain('bg-destructive/10')
    expect(screen.getByText('Disconnected from the backend')).toBeDefined()
    expect(screen.getByText(/Live and polled updates have stopped/i)).toBeDefined()
    expect(screen.getByRole('button', { name: 'Reload page' })).toBeDefined()
  })

  it('calls window.location.reload when Reload page is clicked', () => {
    let reloadCount = 0
    const originalDescriptor = Object.getOwnPropertyDescriptor(window.location, 'reload')
    Object.defineProperty(window.location, 'reload', {
      configurable: true,
      value: () => {
        reloadCount += 1
      },
    })
    try {
      renderWithProviders(<ConnectionBanner status="error" />)
      fireEvent.click(screen.getByRole('button', { name: 'Reload page' }))
      expect(reloadCount).toBe(1)
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(window.location, 'reload', originalDescriptor)
      }
    }
  })

  it('reads status from EventsProvider context when no status prop is given', () => {
    // No EventsProvider in the tree — useEventsConnection() returns the
    // disconnected snapshot (status === 'connecting'), so the banner
    // renders nothing.
    renderWithProviders(<ConnectionBanner />)
    expect(screen.queryByTestId('connection-banner')).toBeNull()
  })
})
