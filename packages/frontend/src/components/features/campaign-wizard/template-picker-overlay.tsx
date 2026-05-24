import { useEffect, useRef } from 'react'

import type { AttackTemplate } from '../../../hooks/use-attack-templates'

import { Button } from '../../ui/button'
import { ErrorBanner } from '../../ui/error-banner'

interface TemplatePickerOverlayProps {
  templates: readonly AttackTemplate[]
  isPending: boolean
  error: string | null
  onPick: (templateId: number) => void
  onClose: () => void
}

/**
 * Returns the focusable descendants of `root` in DOM order. Used by the
 * focus-trap so Tab and Shift+Tab cycle within the dialog instead of
 * escaping back into the underlying page.
 */
function getFocusableDescendants(root: HTMLElement): HTMLElement[] {
  const selector =
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
  return Array.from(root.querySelectorAll<HTMLElement>(selector))
}

/**
 * Modal overlay for picking an attack template to seed the attack form
 * with. Stateless wrapper around the templates list — all data fetching
 * and template instantiation happens in the parent so error handling
 * stays in one place.
 *
 * Focus management:
 * - Initial focus lands on the Cancel button on mount.
 * - Escape closes the dialog.
 * - Tab / Shift+Tab cycles within the dialog (focus trap).
 */
export function TemplatePickerOverlay({
  templates,
  isPending,
  error,
  onPick,
  onClose,
}: TemplatePickerOverlayProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  // oxlint-disable-next-line react/exhaustive-deps -- onClose identity is owned by parent
  useEffect(() => {
    // Initial focus on the Cancel button so the user can dismiss with Enter
    // or Space without first hunting for a focusable target.
    cancelRef.current?.focus()

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const dialog = dialogRef.current
      if (!dialog) return
      const focusable = getFocusableDescendants(dialog)
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!first || !last) return
      const active = document.activeElement as HTMLElement | null
      if (event.shiftKey) {
        if (active === first || !dialog.contains(active)) {
          event.preventDefault()
          last.focus()
        }
      } else if (active === last || !dialog.contains(active)) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <button
        type="button"
        aria-label="Close template picker"
        className="bg-crust/80 absolute inset-0"
        onClick={onClose}
        tabIndex={-1}
      />
      <div
        ref={dialogRef}
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- custom modal: native <dialog> doesn't support the design system's surface tokens
        role="dialog"
        aria-modal="true"
        aria-labelledby="template-picker-title"
        className="border-surface-0 bg-mantle relative z-10 w-full max-w-md rounded-lg border p-4 shadow-2xl"
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 id="template-picker-title" className="text-sm font-medium">
            Select a Template
          </h3>
          <button
            ref={cancelRef}
            type="button"
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring focus-visible:ring-offset-background text-xs focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:outline-none"
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
        {error && <ErrorBanner message={error} className="mb-2 text-xs" />}
        <div className="max-h-64 space-y-1.5 overflow-y-auto">
          {templates.length === 0 ? (
            <p className="text-muted-foreground py-4 text-center text-xs">
              No templates available.
            </p>
          ) : (
            templates.map((template) => (
              <div
                key={template.id}
                className="border-surface-0 bg-surface-0/30 flex items-center justify-between rounded border px-3 py-2"
              >
                <div className="text-xs">
                  <span className="font-medium">{template.name}</span>
                  <span className="text-muted-foreground ml-2 font-mono">Mode {template.mode}</span>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={isPending}
                  onClick={() => onPick(template.id)}
                >
                  Use
                </Button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
