import { describe, expect, it } from 'bun:test'

import { Kbd } from '../../src/components/ui/kbd'
import { cleanupAll, render, screen } from '../test-utils'

describe('Kbd', () => {
  it('renders the shortcut character inside a <kbd> element', () => {
    render(<Kbd>/</Kbd>)
    const el = screen.getByText('/')
    expect(el.tagName).toBe('KBD')
    cleanupAll()
  })

  it('applies the muted chip chrome classes', () => {
    render(<Kbd>E</Kbd>)
    const el = screen.getByText('E')
    expect(el.className).toContain('font-mono')
    expect(el.className).toContain('text-muted-foreground')
    cleanupAll()
  })

  it('merges caller className', () => {
    render(<Kbd className="custom-class">R</Kbd>)
    const el = screen.getByText('R')
    expect(el.className).toContain('custom-class')
    cleanupAll()
  })
})
