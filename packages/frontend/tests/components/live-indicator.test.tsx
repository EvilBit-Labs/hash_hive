import { describe, expect, it } from 'bun:test'

import { LiveIndicator } from '../../src/components/features/results/live-indicator'
import { cleanupAll, render, screen } from '../test-utils'

describe('LiveIndicator', () => {
  it('renders the visible "Live" label', () => {
    render(<LiveIndicator />)
    expect(screen.getByText('Live')).toBeDefined()
    cleanupAll()
  })

  it('exposes the polling cadence in the aria-label', () => {
    render(<LiveIndicator />)
    const label = screen.getByText('Live').closest('span')
    expect(label?.getAttribute('aria-label')).toContain('Live')
    expect(label?.getAttribute('aria-label')).toContain('30 seconds')
    cleanupAll()
  })
})
