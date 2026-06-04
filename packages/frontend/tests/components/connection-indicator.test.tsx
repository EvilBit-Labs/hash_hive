import type { ConnectionStatus } from '@hashhive/shared'

import { afterEach, describe, expect, it } from 'bun:test'

import { ConnectionIndicator } from '../../src/components/features/connection-indicator'
import { cleanupAll, renderWithProviders, screen } from '../test-utils'

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

  it('renders the fallback state with warning color, Activity icon, and "Polling - 60s" label (R14)', () => {
    renderWithProviders(<ConnectionIndicator status="fallback" />)

    // Distinct from error: WS dropped but polling is still functioning, not "Disconnected"
    expect(screen.getByText(/Polling/i)).toBeDefined()
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
