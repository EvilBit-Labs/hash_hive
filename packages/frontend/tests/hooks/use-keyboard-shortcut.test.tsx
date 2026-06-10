import { afterEach, describe, expect, it, mock } from 'bun:test'
import { useEffect } from 'react'

import { useKeyboardShortcut } from '../../src/hooks/use-keyboard-shortcut'
import { cleanupAll, render } from '../test-utils'

afterEach(() => {
  cleanupAll()
})

function Harness({
  shortcutKey,
  handler,
  disabled,
  ignoreEditable,
}: {
  shortcutKey: '/' | 'E' | 'r' | 'Escape' | undefined
  handler: (e: KeyboardEvent) => void
  disabled?: boolean
  ignoreEditable?: boolean
}) {
  useKeyboardShortcut(shortcutKey, handler, {
    ...(disabled !== undefined && { disabled }),
    ...(ignoreEditable !== undefined && { ignoreEditable }),
  })
  return null
}

function dispatch(key: string, init: KeyboardEventInit = {}) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, ...init }))
}

describe('useKeyboardShortcut', () => {
  it('fires the handler when the bound key is pressed on document body', () => {
    const handler = mock()
    render(<Harness shortcutKey="/" handler={handler} />)
    dispatch('/')
    expect(handler).toHaveBeenCalledTimes(1)
    cleanupAll()
  })

  it('does NOT fire when ctrlKey is held (browser collision guard)', () => {
    const handler = mock()
    render(<Harness shortcutKey="E" handler={handler} />)
    dispatch('E', { ctrlKey: true })
    expect(handler).not.toHaveBeenCalled()
    cleanupAll()
  })

  it('does NOT fire when metaKey is held', () => {
    const handler = mock()
    render(<Harness shortcutKey="E" handler={handler} />)
    dispatch('E', { metaKey: true })
    expect(handler).not.toHaveBeenCalled()
    cleanupAll()
  })

  it('does NOT fire when altKey is held', () => {
    const handler = mock()
    render(<Harness shortcutKey="E" handler={handler} />)
    dispatch('E', { altKey: true })
    expect(handler).not.toHaveBeenCalled()
    cleanupAll()
  })

  it('does NOT fire when the target is an editable input', () => {
    const handler = mock()
    render(
      <>
        <input data-testid="search" type="text" aria-label="search" />
        <Harness shortcutKey="/" handler={handler} />
      </>
    )
    const input = document.querySelector<HTMLInputElement>('[data-testid="search"]')
    input?.focus()
    // Dispatch on the focused input directly so the target is the editable element.
    input?.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }))
    expect(handler).not.toHaveBeenCalled()
    cleanupAll()
  })

  it('fires on editable targets when ignoreEditable=false', () => {
    const handler = mock()
    render(
      <>
        <input data-testid="search" type="text" aria-label="search" />
        <Harness shortcutKey="/" handler={handler} ignoreEditable={false} />
      </>
    )
    const input = document.querySelector<HTMLInputElement>('[data-testid="search"]')
    input?.focus()
    input?.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }))
    expect(handler).toHaveBeenCalledTimes(1)
    cleanupAll()
  })

  it('does NOT fire when disabled', () => {
    const handler = mock()
    render(<Harness shortcutKey="r" handler={handler} disabled={true} />)
    dispatch('r')
    expect(handler).not.toHaveBeenCalled()
    cleanupAll()
  })

  it('does NOT fire when key is undefined', () => {
    const handler = mock()
    render(<Harness shortcutKey={undefined} handler={handler} />)
    dispatch('r')
    expect(handler).not.toHaveBeenCalled()
    cleanupAll()
  })

  it('does NOT fire when event.defaultPrevented is true', () => {
    const handler = mock()
    render(<Harness shortcutKey="r" handler={handler} />)
    // Construct an event with `defaultPrevented` already true.
    // happy-dom honors the property when set directly on the event
    // instance via Object.defineProperty (the spec-compliant route
    // — calling `preventDefault()` between listener phases isn't a
    // reliable signal in happy-dom's event model).
    const event = new KeyboardEvent('keydown', { key: 'r' })
    Object.defineProperty(event, 'defaultPrevented', { value: true })
    window.dispatchEvent(event)
    expect(handler).not.toHaveBeenCalled()
  })

  it('catches handler exceptions so future keystrokes still fire', () => {
    const calls: number[] = []
    let throwOnce = true
    function ThrowingHarness() {
      useKeyboardShortcut('r', () => {
        calls.push(calls.length + 1)
        if (throwOnce) {
          throwOnce = false
          throw new Error('boom')
        }
      })
      return null
    }
    render(<ThrowingHarness />)
    expect(() => dispatch('r')).not.toThrow()
    expect(() => dispatch('r')).not.toThrow()
    expect(calls.length).toBe(2)
    cleanupAll()
  })

  it('uses the latest handler reference without re-binding on every render', () => {
    let captured = 0
    function CountingHarness({ value }: { value: number }) {
      useKeyboardShortcut('r', () => {
        captured = value
      })
      useEffect(() => {
        // No-op; just exercises a render
      })
      return null
    }
    const { rerender } = render(<CountingHarness value={1} />)
    dispatch('r')
    expect(captured).toBe(1)
    rerender(<CountingHarness value={42} />)
    dispatch('r')
    expect(captured).toBe(42)
    cleanupAll()
  })

  it('removes the listener on unmount', () => {
    const handler = mock()
    const { unmount } = render(<Harness shortcutKey="r" handler={handler} />)
    unmount()
    dispatch('r')
    expect(handler).not.toHaveBeenCalled()
    cleanupAll()
  })
})
