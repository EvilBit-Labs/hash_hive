import { describe, expect, it } from 'bun:test'

import { TickingNumber } from '../../src/components/features/results/ticking-number'
import { cleanupAll, render, screen } from '../test-utils'

describe('TickingNumber', () => {
  it('renders the formatted children inside a span', () => {
    render(<TickingNumber value={1283}>{'1,283'}</TickingNumber>)
    expect(screen.getByText('1,283')).toBeDefined()
    cleanupAll()
  })

  it('renders the updated children when value changes (no remount-loss of text)', () => {
    const { rerender } = render(<TickingNumber value={1283}>{'1,283'}</TickingNumber>)
    expect(screen.getByText('1,283')).toBeDefined()
    rerender(<TickingNumber value={1286}>{'1,286'}</TickingNumber>)
    expect(screen.getByText('1,286')).toBeDefined()
    cleanupAll()
  })

  it('surfaces the delta as a +N chip when value increases', () => {
    const { rerender } = render(<TickingNumber value={1283}>{'1,283'}</TickingNumber>)
    rerender(<TickingNumber value={1286}>{'1,286'}</TickingNumber>)
    // The delta chip renders +3 next to the new figure.
    expect(screen.getByText('+3')).toBeDefined()
    cleanupAll()
  })

  it('skips the +N chip when the delta is implausibly large (filter/project switch)', () => {
    const { rerender } = render(<TickingNumber value={50}>{'50'}</TickingNumber>)
    rerender(<TickingNumber value={5000}>{'5,000'}</TickingNumber>)
    expect(screen.queryByText(/^\+/)).toBeNull()
    cleanupAll()
  })

  it('applies the className prop to the rendered figure', () => {
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
