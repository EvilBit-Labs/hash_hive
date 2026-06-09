import { describe, expect, it } from 'bun:test'

import { TickingNumber } from '../../src/components/features/results/ticking-number'
import { cleanupAll, render, screen } from '../test-utils'

describe('TickingNumber', () => {
  it('renders the formatted children inside a span', () => {
    render(<TickingNumber value={1283}>{'1,283'}</TickingNumber>)
    expect(screen.getByText('1,283')).toBeDefined()
    cleanupAll()
  })

  it('keeps the same rendered text when value changes (Motion handles the visual ack)', () => {
    const { rerender } = render(<TickingNumber value={1283}>{'1,283'}</TickingNumber>)
    expect(screen.getByText('1,283')).toBeDefined()
    rerender(<TickingNumber value={1284}>{'1,284'}</TickingNumber>)
    expect(screen.getByText('1,284')).toBeDefined()
    cleanupAll()
  })

  it('applies the className prop to the rendered element', () => {
    render(
      <TickingNumber value={42} className="font-semibold text-foreground">
        {'42'}
      </TickingNumber>
    )
    const el = screen.getByText('42')
    expect(el.className).toContain('font-semibold')
    cleanupAll()
  })
})
