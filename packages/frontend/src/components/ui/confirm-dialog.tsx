import { useRef } from 'react'

import { Button } from './button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './dialog'

interface ConfirmDialogProps {
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
  /**
   * While true, disables the Cancel/Confirm buttons and suppresses Escape /
   * outside-click dismissal — so `onCancel` does NOT fire while busy. Set this
   * while an async confirm action is in-flight.
   */
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/**
 * Lightweight modal for confirming destructive or otherwise non-trivial
 * actions. Replaces `window.confirm` for surfaces that need styled,
 * focusable, screen-reader-friendly confirmation. Backed by Radix Dialog
 * (focus trap, Escape, portal, scroll lock) — the public API is unchanged
 * so existing callsites are untouched. While `busy`, dismissal via Escape
 * or outside-click is suppressed so an in-flight action cannot be abandoned.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  // The element that had focus when the dialog opened. Radix's default
  // focus restore can land on <body> for a controlled dialog (no
  // DialogTrigger), so we capture and restore the trigger ourselves.
  const triggerRef = useRef<HTMLElement | null>(null)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onCancel()
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="max-w-md"
        onOpenAutoFocus={() => {
          // Fires on the dialog container before Radix's FocusScope moves focus
          // to the first tabbable element, so document.activeElement is still
          // the trigger that opened the dialog.
          triggerRef.current = document.activeElement as HTMLElement | null
        }}
        onCloseAutoFocus={(event) => {
          const trigger = triggerRef.current
          if (trigger && document.contains(trigger)) {
            event.preventDefault()
            trigger.focus()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{message}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'primary'}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? 'Working...' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
