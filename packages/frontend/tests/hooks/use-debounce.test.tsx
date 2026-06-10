import { describe, expect, it } from 'bun:test'
import { useState } from 'react'

import { useDebounce } from '../../src/hooks/use-debounce'
import { cleanupAll, render, screen } from '../test-utils'

function Probe({ initial, delay }: { initial: string; delay: number }) {
  const [value, setValue] = useState(initial)
  const debounced = useDebounce(value, delay)
  return (
    <>
      <button onClick={() => setValue('typed')} data-testid="set">
        set
      </button>
      <span data-testid="debounced">{debounced}</span>
    </>
  )
}

describe('useDebounce', () => {
  it('returns the initial value synchronously on mount', () => {
    render(<Probe initial="initial" delay={50} />)
    expect(screen.getByTestId('debounced').textContent).toBe('initial')
    cleanupAll()
  })

  it('updates the debounced value after the delay elapses', async () => {
    render(<Probe initial="initial" delay={20} />)
    screen.getByTestId('set').click()
    // Wait slightly longer than the delay for the debounced update.
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(screen.getByTestId('debounced').textContent).toBe('typed')
    cleanupAll()
  })

  it('does NOT update immediately on input change (before delay)', () => {
    render(<Probe initial="initial" delay={1000} />)
    screen.getByTestId('set').click()
    // No await — debounced should still hold the initial value.
    expect(screen.getByTestId('debounced').textContent).toBe('initial')
    cleanupAll()
  })
})
