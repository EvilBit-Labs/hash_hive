import { afterEach, describe, expect, it, mock } from 'bun:test'

import { useDashboardShortcuts } from '../../src/hooks/use-dashboard-shortcuts'
import { cleanupAll, renderHook } from '../test-utils'

afterEach(cleanupAll)

interface Spies {
  onRefresh: ReturnType<typeof mock>
  onNavigate: ReturnType<typeof mock>
  onProjectPicker: ReturnType<typeof mock>
}

function makeSpies(): Spies {
  return {
    onRefresh: mock(() => {}),
    onNavigate: mock(() => {}),
    onProjectPicker: mock(() => {}),
  }
}

function mountWithSpies(spies: Spies) {
  return renderHook(() => useDashboardShortcuts(spies))
}

function dispatchKey(init: KeyboardEventInit & { target?: EventTarget }) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  if (init.target) {
    Object.defineProperty(event, 'target', { value: init.target, writable: false })
    init.target.dispatchEvent(event)
  } else {
    window.dispatchEvent(event)
  }
  return event
}

describe('useDashboardShortcuts', () => {
  it('fires onRefresh when R is pressed without modifiers', () => {
    const spies = makeSpies()
    mountWithSpies(spies)
    dispatchKey({ key: 'r' })
    expect(spies.onRefresh).toHaveBeenCalledTimes(1)
    expect(spies.onNavigate).not.toHaveBeenCalled()
    expect(spies.onProjectPicker).not.toHaveBeenCalled()
  })

  it('also fires onRefresh for capital R (caps lock / shift typing)', () => {
    // Capital R with no shiftKey set — happens under caps lock, which
    // is the "shift is logically off" case for our routing.
    const spies = makeSpies()
    mountWithSpies(spies)
    dispatchKey({ key: 'R', shiftKey: false })
    expect(spies.onRefresh).toHaveBeenCalledTimes(1)
  })

  it.each([
    [1, '1'],
    [2, '2'],
    [3, '3'],
    [4, '4'],
  ] as const)('fires onNavigate(%i) when %s is pressed', (slot, key) => {
    const spies = makeSpies()
    mountWithSpies(spies)
    dispatchKey({ key })
    expect(spies.onNavigate).toHaveBeenCalledTimes(1)
    expect(spies.onNavigate).toHaveBeenCalledWith(slot)
  })

  it('fires onProjectPicker when Shift+P is pressed', () => {
    const spies = makeSpies()
    mountWithSpies(spies)
    dispatchKey({ key: 'P', shiftKey: true })
    expect(spies.onProjectPicker).toHaveBeenCalledTimes(1)
  })

  it('also fires onProjectPicker for Shift+p (some keymaps emit lowercase)', () => {
    const spies = makeSpies()
    mountWithSpies(spies)
    dispatchKey({ key: 'p', shiftKey: true })
    expect(spies.onProjectPicker).toHaveBeenCalledTimes(1)
  })

  it('ignores Shift+R (shift disqualifies the unshifted accelerators)', () => {
    const spies = makeSpies()
    mountWithSpies(spies)
    dispatchKey({ key: 'R', shiftKey: true })
    expect(spies.onRefresh).not.toHaveBeenCalled()
  })

  it('ignores Shift+1 (shift disqualifies digit navigation)', () => {
    const spies = makeSpies()
    mountWithSpies(spies)
    dispatchKey({ key: '1', shiftKey: true })
    expect(spies.onNavigate).not.toHaveBeenCalled()
  })

  it('ignores Shift+P when a focused input is the source (typing-in-field guard)', () => {
    const spies = makeSpies()
    mountWithSpies(spies)
    const input = document.createElement('input')
    document.body.appendChild(input)
    dispatchKey({ key: 'P', shiftKey: true, target: input })
    document.body.removeChild(input)
    expect(spies.onProjectPicker).not.toHaveBeenCalled()
  })

  it('reads the latest handlers via ref on each fire (no stale-closure capture)', () => {
    // The hook stores handlers in a ref so consumers do not have to
    // memoize. If a future refactor swaps the ref pattern for a deps
    // array on the listener effect, the test will catch the stale
    // closure: pressing R after a rerender must fire the NEW spy,
    // not the spy from the initial mount.
    const oldRefresh = mock(() => {})
    const oldNavigate = mock(() => {})
    const oldPicker = mock(() => {})

    const { rerender } = renderHook((h: Spies) => useDashboardShortcuts(h), {
      initialProps: {
        onRefresh: oldRefresh,
        onNavigate: oldNavigate,
        onProjectPicker: oldPicker,
      },
    })

    const newRefresh = mock(() => {})
    rerender({
      onRefresh: newRefresh,
      onNavigate: oldNavigate,
      onProjectPicker: oldPicker,
    })

    dispatchKey({ key: 'r' })
    expect(newRefresh).toHaveBeenCalledTimes(1)
    expect(oldRefresh).not.toHaveBeenCalled()
  })

  it('surfaces a handler throw via console.error rather than swallowing it silently', () => {
    const spies: Spies = {
      onRefresh: mock(() => {
        throw new Error('boom')
      }),
      onNavigate: mock(() => {}),
      onProjectPicker: mock(() => {}),
    }
    const originalError = console.error
    const errorSpy = mock(() => {})
    console.error = errorSpy
    try {
      mountWithSpies(spies)
      dispatchKey({ key: 'r' })
      expect(errorSpy).toHaveBeenCalledTimes(1)
      const firstCall = errorSpy.mock.calls[0]
      const firstArg = firstCall && firstCall.length > 0 ? String(firstCall[0]) : ''
      expect(firstArg).toContain('onRefresh')
    } finally {
      console.error = originalError
    }
  })

  it.each(['Ctrl', 'Meta', 'Alt'] as const)(
    'ignores R when %s is held (compound belongs to the browser/OS)',
    (modifier) => {
      const spies = makeSpies()
      mountWithSpies(spies)
      dispatchKey({
        key: 'r',
        ctrlKey: modifier === 'Ctrl',
        metaKey: modifier === 'Meta',
        altKey: modifier === 'Alt',
      })
      expect(spies.onRefresh).not.toHaveBeenCalled()
    }
  )

  it('ignores R when an input element is focused', () => {
    const spies = makeSpies()
    mountWithSpies(spies)
    const input = document.createElement('input')
    document.body.appendChild(input)
    dispatchKey({ key: 'r', target: input })
    document.body.removeChild(input)
    expect(spies.onRefresh).not.toHaveBeenCalled()
  })

  it('ignores 1 when a textarea is focused', () => {
    const spies = makeSpies()
    mountWithSpies(spies)
    const ta = document.createElement('textarea')
    document.body.appendChild(ta)
    dispatchKey({ key: '1', target: ta })
    document.body.removeChild(ta)
    expect(spies.onNavigate).not.toHaveBeenCalled()
  })

  it('ignores R when a select is focused (e.g. project picker)', () => {
    const spies = makeSpies()
    mountWithSpies(spies)
    const select = document.createElement('select')
    document.body.appendChild(select)
    dispatchKey({ key: 'r', target: select })
    document.body.removeChild(select)
    expect(spies.onRefresh).not.toHaveBeenCalled()
  })

  it('ignores R when a contenteditable element is focused', () => {
    const spies = makeSpies()
    mountWithSpies(spies)
    const div = document.createElement('div')
    div.contentEditable = 'true'
    document.body.appendChild(div)
    dispatchKey({ key: 'r', target: div })
    document.body.removeChild(div)
    expect(spies.onRefresh).not.toHaveBeenCalled()
  })

  it('removes its listener on unmount', () => {
    const spies = makeSpies()
    const { unmount } = mountWithSpies(spies)
    unmount()
    dispatchKey({ key: 'r' })
    expect(spies.onRefresh).not.toHaveBeenCalled()
  })

  it('preventDefault is called on handled keys', () => {
    const spies = makeSpies()
    mountWithSpies(spies)
    const event = dispatchKey({ key: 'r' })
    expect(event.defaultPrevented).toBe(true)
  })

  it('preventDefault is NOT called on unhandled keys (lets typing pass through)', () => {
    const spies = makeSpies()
    mountWithSpies(spies)
    const event = dispatchKey({ key: 'a' })
    expect(event.defaultPrevented).toBe(false)
    expect(spies.onRefresh).not.toHaveBeenCalled()
  })
})
