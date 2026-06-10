import { useEffect, useRef } from 'react'

/**
 * Constrained shortcut keys supported by the Results surfaces today.
 * Adding a new shortcut means adding the literal here first — that's
 * the catch for typos like `'Esc'` (real `event.key` is `'Escape'`)
 * or `'e'` (lowercase only matches if Shift isn't held; we usually
 * want the uppercase form so a deliberate Shift+E is a no-op).
 *
 * Keep the union tight; speculative entries are real cost (they
 * mislead future callers about what's safe to bind).
 */
export type ShortcutKey =
  | '/'
  | '?'
  | 'E'
  | 'r'
  | 'R'
  | 'Escape'
  | 'Enter'
  | 'ArrowUp'
  | 'ArrowDown'
  | 'ArrowLeft'
  | 'ArrowRight'

interface ShortcutOptions {
  /**
   * Skip the shortcut when the keydown target is an input, textarea,
   * select, or contenteditable element. Defaults to true so a `/`
   * press inside a search field doesn't re-focus the same field.
   */
  readonly ignoreEditable?: boolean
  /**
   * Disable the shortcut without unmounting the call site (e.g. while
   * a confirm dialog is open). Defaults to false.
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
 * Bind a single-key shortcut at the window level for the lifetime of
 * the calling component. The handler reference is kept in a ref so
 * callers don't have to memoize — the listener only re-registers when
 * the key or options change.
 *
 * ## Invariants (some unstated by the type signature)
 *
 * - **Ctrl / Cmd / Alt are suppressed**; app-level shortcuts will not
 *   collide with browser ones (Cmd+E, Cmd+/, etc).
 * - **Shift is NOT suppressed.** This is deliberate so a Shift-bearing
 *   key like `?` (which arrives as `event.key === '?'` with `shiftKey:
 *   true`) still fires. Callers that need a Shift-free binding should
 *   inspect `event.shiftKey` inside the handler.
 * - **`event.defaultPrevented` is respected.** A child handler can opt
 *   the shortcut out by calling `preventDefault()`.
 * - **The hook does NOT call `preventDefault()` itself.** Callers that
 *   need to swallow the keypress (e.g. `/` lands as a character once
 *   the input takes focus) must call it in their own handler.
 * - **Listener is on `window` in the bubble phase.** A capture-phase
 *   listener that wins over child handlers is out of scope.
 * - **Handler exceptions are caught and logged**, not re-thrown. The
 *   user is mid-keystroke — there's nothing actionable from a thrown
 *   error, and letting it escape would route to `window.onerror` where
 *   it dies silently.
 *
 * Pass `key: undefined` to skip the binding entirely (equivalent to
 * `disabled: true` but cleaner at the call site when the shortcut is
 * conditionally configured).
 */
export function useKeyboardShortcut(
  key: ShortcutKey | undefined,
  handler: (event: KeyboardEvent) => void,
  options: ShortcutOptions = {}
): void {
  const { ignoreEditable = true, disabled = false } = options
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  useEffect(() => {
    if (disabled || key === undefined) return
    const targetKey = key.toLowerCase()
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented) return
      // Letter-key shortcuts are matched case-insensitively so an
      // export bound as 'E' fires whether the operator types E,
      // Shift+E, or e with Caps Lock on. Non-letter keys (`/`,
      // `Escape`, arrows) only have one form so the lowercase
      // comparison is a no-op for them.
      if (event.key.toLowerCase() !== targetKey) return
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (ignoreEditable && isEditable(event.target)) return
      try {
        handlerRef.current(event)
      } catch (err) {
        // The keystroke is over; re-throwing would route via
        // window.onerror where it dies silently and the next press
        // would crash the same way. Log loudly and move on.
        // oxlint-disable-next-line no-console -- keyboard-shortcut handler failures must be debuggable in dev
        console.error('[useKeyboardShortcut] handler threw', { key, err })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [key, ignoreEditable, disabled])
}
