import { describe, expect, it } from 'bun:test'

import { CrackRatePercent } from '../../src/components/features/results/crack-rate-percent'
import { cleanupAll, render, screen } from '../test-utils'

describe('CrackRatePercent', () => {
  it('renders the percentage in muted color when below 100%', () => {
    render(<CrackRatePercent value={25.7} />)
    const el = screen.getByText('(25.7%)')
    expect(el.className).toContain('text-muted-foreground')
    cleanupAll()
  })

  it('renders the milestone treatment in peach + semibold at 100%', () => {
    render(<CrackRatePercent value={100} />)
    const el = screen.getByText('(100.0%)')
    expect(el.className).toContain('text-primary')
    expect(el.className).toContain('font-semibold')
    cleanupAll()
  })

  it('still hits the milestone for values that round to 100.0', () => {
    render(<CrackRatePercent value={99.97} />)
    const el = screen.getByText('(100.0%)')
    expect(el.className).toContain('text-primary')
    cleanupAll()
  })

  it('formats values to one decimal place', () => {
    render(<CrackRatePercent value={42.358} />)
    expect(screen.getByText('(42.4%)')).toBeDefined()
    cleanupAll()
  })

  it('renders a neutral hyphen for NaN, Infinity, and negative inputs', () => {
    const { rerender } = render(<CrackRatePercent value={Number.NaN} />)
    expect(screen.getByText('(-%)')).toBeDefined()
    rerender(<CrackRatePercent value={Number.POSITIVE_INFINITY} />)
    expect(screen.getByText('(-%)')).toBeDefined()
    rerender(<CrackRatePercent value={-5} />)
    expect(screen.getByText('(-%)')).toBeDefined()
    cleanupAll()
  })

  it('stays in the muted treatment for 99.94 (just below the milestone boundary)', () => {
    render(<CrackRatePercent value={99.94} />)
    const el = screen.getByText('(99.9%)')
    expect(el.className).toContain('text-muted-foreground')
    expect(el.className).not.toContain('text-primary')
    cleanupAll()
  })

  it('coerces negative zero to zero so the figure is not rendered as -0.0%', () => {
    render(<CrackRatePercent value={-0} />)
    expect(screen.getByText('(0.0%)')).toBeDefined()
    cleanupAll()
  })
})
