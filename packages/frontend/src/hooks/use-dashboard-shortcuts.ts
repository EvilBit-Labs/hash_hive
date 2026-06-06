import { useEffect, useRef } from 'react'

export type DashboardShortcutSlot = 1 | 2 | 3 | 4

interface DashboardShortcutHandlers {
  readonly onRefresh: () => void
  readonly onNavigate: (slot: DashboardShortcutSlot) => void
  readonly onProjectPicker: () => void
}

const NAVIGATION_KEYS: Readonly<Record<string, DashboardShortcutSlot>> = {
  '1': 1,
  '2': 2,
  '3': 3,
  '4': 4,
}

function isTypingInField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return target.isContentEditable
}

function safeInvoke(label: string, fn: () => void): void {
  // Synchronous throws inside a keydown listener vanish after
  // preventDefault has already fired: the user sees nothing, and the
  // bug is invisible until someone opens DevTools and notices the
  // shortcut "feels broken". Surface the error so a stale `navigate`
  // route or a consumer mistake at least leaves a trail.
  try {
    fn()
  } catch (err) {
    console.error(`useDashboardShortcuts ${label} handler threw`, err)
  }
}

/**
 * Wires window-level keyboard accelerators for the dashboard page.
 *
 * Handlers are read through a ref so the consumer never has to memoize
 * the object; the listener mounts once for the lifetime of the page.
 *
 * Suppressed when the user is typing in an input, textarea, select, or
 * contenteditable surface, and when Ctrl/Meta/Alt is held (those
 * compounds belong to the browser or the OS). Current bindings live in
 * the handler body and on the dashboard header's kbd hints; if you add
 * a binding update both.
 */
export function useDashboardShortcuts(handlers: DashboardShortcutHandlers): void {
  const handlersRef = useRef(handlers)

  useEffect(() => {
    handlersRef.current = handlers
  })

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isTypingInField(event.target)) return
      if (event.ctrlKey || event.metaKey || event.altKey) return

      const { key, shiftKey } = event

      if (shiftKey && (key === 'P' || key === 'p')) {
        event.preventDefault()
        safeInvoke('onProjectPicker', handlersRef.current.onProjectPicker)
        return
      }

      // Shift alone disqualifies the unshifted accelerators below — we
      // don't want Shift+R or Shift+1 to fire navigation by accident.
      if (shiftKey) return

      if (key === 'r' || key === 'R') {
        event.preventDefault()
        safeInvoke('onRefresh', handlersRef.current.onRefresh)
        return
      }

      const slot = NAVIGATION_KEYS[key]
      if (slot !== undefined) {
        event.preventDefault()
        safeInvoke('onNavigate', () => handlersRef.current.onNavigate(slot))
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
