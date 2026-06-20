import { useCallback, useEffect, useRef, useState } from 'react'

/** How long the "copied" confirmation stays lit before reverting. */
const COPIED_FLASH_MS = 1_500

interface UseCopyToClipboard {
  /** True for a brief flash after a successful copy. */
  readonly copied: boolean
  /** True when the copy could not be performed (insecure context or rejection). */
  readonly copyFailed: boolean
  /** Attempt to copy `value` to the clipboard. Never throws. */
  readonly copy: (value: string) => void
}

/**
 * Single source of truth for the copy-to-clipboard behaviour used across the
 * first-run surfaces (enroll command, enrollment token, Control API key).
 * Replaces three near-identical inline implementations that handled the
 * insecure-context guard and the rejection path subtly differently.
 *
 * `navigator.clipboard` is undefined in non-secure contexts (plain http,
 * some embedded webviews); reading `.writeText` there throws a TypeError
 * synchronously, which a `.catch` cannot catch. We short-circuit that path
 * to a visible `copyFailed` (the text stays selectable for manual copy)
 * rather than letting the click crash the page or silently no-op.
 */
export function useCopyToClipboard(flashMs: number = COPIED_FLASH_MS): UseCopyToClipboard {
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    },
    []
  )

  const copy = useCallback(
    (value: string) => {
      if (typeof navigator === 'undefined' || !navigator.clipboard) {
        setCopied(false)
        setCopyFailed(true)
        return
      }
      void navigator.clipboard.writeText(value).then(
        () => {
          setCopied(true)
          setCopyFailed(false)
          if (timeoutRef.current) clearTimeout(timeoutRef.current)
          timeoutRef.current = setTimeout(() => setCopied(false), flashMs)
        },
        () => {
          // Clear any lingering "copied" flash from a prior success so the UI
          // never shows "Copied" and the failure hint at the same time.
          setCopied(false)
          setCopyFailed(true)
        }
      )
    },
    [flashMs]
  )

  return { copied, copyFailed, copy }
}
