import { afterEach, describe, expect, it } from 'bun:test'

import { ConnectionIndicator } from '../../src/components/features/connection-indicator'
import { cleanupAll, renderWithProviders, screen } from '../test-utils'

afterEach(cleanupAll)

describe('ConnectionIndicator', () => {
  it('shows "Live" with green dot when status is open', () => {
    renderWithProviders(<ConnectionIndicator status="open" />)

    expect(screen.getByText('Live')).toBeDefined()
    expect(document.querySelector('.bg-success')).not.toBeNull()
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('Live')
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

  it('shows "Offline - polling" with destructive dot for fallback status', () => {
    renderWithProviders(<ConnectionIndicator status="fallback" />)

    expect(screen.getByText('Offline - polling')).toBeDefined()
    expect(document.querySelector('.bg-destructive')).not.toBeNull()
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('Offline - polling')
  })

  it('shows "Disconnected" with destructive dot for error status', () => {
    renderWithProviders(<ConnectionIndicator status="error" />)

    expect(screen.getByText('Disconnected')).toBeDefined()
    expect(document.querySelector('.bg-destructive')).not.toBeNull()
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('Disconnected')
  })

  it('renders the disconnected default when used outside EventsProvider', () => {
    // No `status` prop and no EventsProvider — useEventsConnection() returns
    // its fallback snapshot (status === 'connecting').
    renderWithProviders(<ConnectionIndicator />)
    expect(screen.getByText('Reconnecting...')).toBeDefined()
  })
})
