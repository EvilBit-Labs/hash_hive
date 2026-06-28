import { afterEach, describe, expect, it } from 'bun:test'

import { Skeleton } from '../../src/components/ui/skeleton'
import { cleanupAll, render, screen } from '../test-utils'

afterEach(() => {
  cleanupAll()
})

describe('Skeleton', () => {
  // R5: renders an aria-hidden decorative element
  it('is marked aria-hidden so screen readers skip the decorative placeholder', () => {
    render(<Skeleton data-testid="sk" />)
    const el = screen.getByTestId('sk')
    expect(el.getAttribute('aria-hidden')).toBe('true')
  })

  it('renders with the animate-pulse and default surface classes', () => {
    render(<Skeleton data-testid="sk" />)
    const el = screen.getByTestId('sk')
    expect(el.className).toContain('animate-pulse')
    expect(el.className).toContain('rounded-md')
    expect(el.className).toContain('bg-surface-0/60')
  })

  // R5: caller className merges and can override the default surface
  it('merges a caller className — size utilities are additive', () => {
    render(<Skeleton data-testid="sk" className="h-10 w-full" />)
    const el = screen.getByTestId('sk')
    expect(el.className).toContain('h-10')
    expect(el.className).toContain('w-full')
  })

  it('caller className can override the default surface via twMerge', () => {
    render(<Skeleton data-testid="sk" className="bg-mantle" />)
    const el = screen.getByTestId('sk')
    // twMerge keeps the later bg utility and drops the default
    expect(el.className).toContain('bg-mantle')
    expect(el.className).not.toContain('bg-surface-0/60')
  })
})
