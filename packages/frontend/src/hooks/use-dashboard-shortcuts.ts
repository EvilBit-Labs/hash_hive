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

/**
 * Wires the dashboard's window-level keyboard accelerators:
 *
 * - `R` (no modifiers) — force-refetch the dashboard query
 * - `1` / `2` / `3` / `4` — jump to Agents / Campaigns / Tasks / Results
 * - `Shift+P` — focus the project picker
 *
 * Handlers are read through a ref so the consumer never has to memoize
 * the object; the listener mounts once for the lifetime of the page.
 *
 * Suppressed when the user is typing in an input, textarea, select, or
 * contenteditable surface, and when Ctrl/Meta/Alt is held (those
 * compounds belong to the browser or the OS).
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
        handlersRef.current.onProjectPicker()
        return
      }

      // Shift alone disqualifies the unshifted accelerators below — we
      // don't want Shift+R or Shift+1 to fire navigation by accident.
      if (shiftKey) return

      if (key === 'r' || key === 'R') {
        event.preventDefault()
        handlersRef.current.onRefresh()
        return
      }

      const slot = NAVIGATION_KEYS[key]
      if (slot !== undefined) {
        event.preventDefault()
        handlersRef.current.onNavigate(slot)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
