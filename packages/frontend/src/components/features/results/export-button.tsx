import { useCallback, useEffect, useState } from 'react'

import { type ExportResultsFilters, useExportResults } from '../../../hooks/use-export-results'
import { type ShortcutKey, useKeyboardShortcut } from '../../../hooks/use-keyboard-shortcut'
import { useUiStore } from '../../../stores/ui'
import { Button } from '../../ui/button'
import { Kbd } from '../../ui/kbd'

interface ExportButtonProps {
  readonly filters: ExportResultsFilters
  readonly label?: string
  /**
   * Optional keyboard shortcut that triggers the export from anywhere
   * on the page (modulo editable-element targets). Rendered as a
   * visible Kbd chip inside the button so operators discover the
   * shortcut at a glance.
   */
  readonly shortcutKey?: ShortcutKey
}

const SUCCESS_ACK_MS = 1500

function resolveErrorMessage(isError: boolean, error: unknown): string | null {
  if (!isError) return null
  if (error instanceof Error) return error.message
  return 'Export failed'
}

/**
 * CSV export trigger backed by `useExportResults`. Disabled while
 * pending (so a second click cannot fire a parallel download) and
 * when no project is selected. On success the label flips to
 * "Exported" for ~1.5s before reverting — the peak-end acknowledgment
 * .impeccable.md asks for on completed operator actions. The success
 * ack also clears immediately when a new export starts or fails, so a
 * rapid retry-then-fail run can't leave "Exported" on a button whose
 * inline error reports failure.
 */
export function ExportButton({ filters, label = 'Export CSV', shortcutKey }: ExportButtonProps) {
  const selectedProjectId = useUiStore((s) => s.selectedProjectId)
  const exportMutation = useExportResults()
  const [justSucceeded, setJustSucceeded] = useState(false)

  // Success-ack timer.
  useEffect(() => {
    if (!exportMutation.isSuccess) return
    setJustSucceeded(true)
    const t = setTimeout(() => setJustSucceeded(false), SUCCESS_ACK_MS)
    return () => clearTimeout(t)
  }, [exportMutation.isSuccess, exportMutation.submittedAt])

  // Clear the success ack the moment a new attempt starts or fails.
  // Without this, the timer-driven reset above would leave "Exported"
  // visible while a subsequent attempt is mid-flight or has just
  // errored, producing a "Exported" label next to a destructive
  // error banner — misleading UX.
  useEffect(() => {
    if (exportMutation.isPending || exportMutation.isError) {
      setJustSucceeded(false)
    }
  }, [exportMutation.isPending, exportMutation.isError])

  const isDisabled = selectedProjectId === null || exportMutation.isPending

  function resolveLabel(): string {
    if (exportMutation.isPending) return 'Exporting...'
    if (justSucceeded) return 'Exported'
    return label
  }
  const buttonLabel = resolveLabel()
  const errorMessage = resolveErrorMessage(exportMutation.isError, exportMutation.error)

  const triggerExport = useCallback(() => {
    if (isDisabled) return
    exportMutation.mutate(filters)
  }, [exportMutation, filters, isDisabled])

  useKeyboardShortcut(shortcutKey, triggerExport, { disabled: isDisabled })

  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="secondary" size="sm" disabled={isDisabled} onClick={triggerExport}>
        <span className="inline-flex items-center gap-1.5">
          {buttonLabel}
          {shortcutKey && !isDisabled && !justSucceeded && <Kbd>{shortcutKey}</Kbd>}
        </span>
      </Button>
      {errorMessage && (
        <span role="alert" className="text-xs text-destructive">
          {errorMessage}
        </span>
      )}
    </div>
  )
}
