import { Button } from './button'

interface ConfirmDialogProps {
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/**
 * Lightweight modal for confirming destructive or otherwise non-trivial
 * actions. Replaces `window.confirm` for surfaces that need styled,
 * focusable, screen-reader-friendly confirmation. Mirrors the visual
 * shell of `ResourceUploadModal` so the dashboard reads consistently.
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
  if (!open) return null

  return (
    <div className="bg-crust/80 fixed inset-0 z-50 flex items-center justify-center">
      <div
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- custom modal: native <dialog> doesn't support the design system's surface tokens
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        className="border-surface-0 bg-mantle w-full max-w-md rounded-lg border p-6 shadow-2xl"
      >
        <h3 id="confirm-dialog-title" className="mb-2 text-sm font-medium">
          {title}
        </h3>
        <p className="text-muted-foreground text-xs">{message}</p>
        <div className="mt-6 flex justify-end gap-2">
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
        </div>
      </div>
    </div>
  )
}
