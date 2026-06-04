import { afterEach, describe, expect, it } from 'bun:test'

import { Skeleton } from '../../src/components/ui/skeleton'
import { cleanupAll, render, screen } from '../test-utils'

afterEach(() => {
  cleanupAll()
})

describe('Skeleton', () => {
  it('renders with default classes when no className is provided', () => {
    render(<Skeleton data-testid="sk" />)
    const el = screen.getByTestId('sk')
    expect(el.className).toContain('animate-pulse')
    expect(el.className).toContain('rounded-md')
    expect(el.className).toContain('bg-surface-0/60')
  })

  it('merges a custom className with defaults without duplicating conflicting utilities', () => {
    render(<Skeleton data-testid="sk" className="bg-mantle h-10 w-full" />)
    const el = screen.getByTestId('sk')
    expect(el.className).toContain('h-10')
    expect(el.className).toContain('w-full')
    // twMerge keeps the later bg utility and drops the default
    expect(el.className).toContain('bg-mantle')
    expect(el.className).not.toContain('bg-surface-0/60')
  })

  it('is marked aria-hidden so screen readers skip the decorative placeholder', () => {
    render(<Skeleton data-testid="sk" />)
    const el = screen.getByTestId('sk')
    expect(el.getAttribute('aria-hidden')).toBe('true')
  })
})
