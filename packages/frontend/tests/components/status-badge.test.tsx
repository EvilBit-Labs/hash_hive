import { cleanup, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'

import { StatusBadge } from '../../src/components/features/status-badge'
import { renderWithProviders } from '../test-utils'

afterEach(cleanup)

describe('StatusBadge', () => {
  it('should render the status text', () => {
    renderWithProviders(<StatusBadge status="online" />)
    expect(screen.getByText('online')).toBeDefined()
  })

  it('should render unknown statuses with pending styling', () => {
    renderWithProviders(<StatusBadge status="something-unknown" />)
    expect(screen.getByText('something-unknown')).toBeDefined()
  })

  it.each(['online', 'offline', 'busy', 'error', 'running', 'paused', 'completed', 'pending'])(
    'should render %s status',
    (status) => {
      renderWithProviders(<StatusBadge status={status} />)
      const badge = screen.getByText(status)
      expect(badge).toBeDefined()
      expect(badge.className).toContain('rounded-full')
    }
  )

  describe('online-transition pulse', () => {
    it('does not play the halo on mount, even when already online', () => {
      // A page load showing already-online agents is not a transition —
      // pulsing them all would be chrome noise, not a real operator moment.
      const { container } = renderWithProviders(<StatusBadge status="online" pulseOnOnline />)
      expect(container.querySelector('.animate-ping')).toBeNull()
    })

    it('plays a one-shot halo when status transitions offline -> online', () => {
      const { container, rerender } = renderWithProviders(
        <StatusBadge status="offline" pulseOnOnline />
      )
      expect(container.querySelector('.animate-ping')).toBeNull()
      rerender(<StatusBadge status="online" pulseOnOnline />)
      expect(container.querySelector('.animate-ping')).not.toBeNull()
    })

    it('does not pulse on transition when pulseOnOnline is not set', () => {
      const { container, rerender } = renderWithProviders(<StatusBadge status="offline" />)
      rerender(<StatusBadge status="online" />)
      expect(container.querySelector('.animate-ping')).toBeNull()
    })
  })
})
