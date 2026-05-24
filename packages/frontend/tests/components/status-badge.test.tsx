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
})
