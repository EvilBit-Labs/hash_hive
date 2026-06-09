import { useEffect, useRef } from 'react'

interface ShortcutOptions {
  /**
   * Skip the shortcut when the keydown target is an input, textarea,
   * select, or contenteditable element. Defaults to true so a `/` press
   * inside a search field doesn't re-focus the same field.
   */
  readonly ignoreEditable?: boolean
  /**
   * Disable the shortcut without unmounting the call site (e.g. while a
   * confirm dialog is open). Defaults to false.
   */
  readonly disabled?: boolean
}

const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (EDITABLE_TAGS.has(target.tagName)) return true
  if (target.isContentEditable) return true
  return false
}

/**
 * Bind a single-key shortcut at the window level for the lifetime of the
 * calling component. The handler reference is kept in a ref so callers
 * don't have to memoize it — the listener only re-registers when the
 * key or options change.
 *
 * Modifier-pressed keystrokes (Ctrl/Cmd/Alt) are ignored so app-level
 * shortcuts don't collide with the browser's own (Cmd+E, Cmd+/, etc.).
 * `defaultPrevented` events are also ignored so a child handler can
 * opt out by preventing the event.
 */
export function useKeyboardShortcut(
  key: string,
  handler: (event: KeyboardEvent) => void,
  options: ShortcutOptions = {}
): void {
  const { ignoreEditable = true, disabled = false } = options
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  useEffect(() => {
    if (disabled) return
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented) return
      if (event.key !== key) return
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (ignoreEditable && isEditable(event.target)) return
      handlerRef.current(event)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [key, ignoreEditable, disabled])
}
