import { useCallback, useEffect, useState } from 'react'

import { type ExportResultsFilters, useExportResults } from '../../../hooks/use-export-results'
import { useKeyboardShortcut } from '../../../hooks/use-keyboard-shortcut'
import { useUiStore } from '../../../stores/ui'
import { Button } from '../../ui/button'
import { Kbd } from '../../ui/kbd'

interface ExportButtonProps {
  readonly filters: ExportResultsFilters
  readonly label?: string
  /**
   * Optional keyboard shortcut that triggers the export from anywhere
   * on the page (modulo editable-element targets). The character is
   * also rendered as a visible Kbd chip inside the button so operators
   * can discover the shortcut at a glance.
   */
  readonly shortcutKey?: string
}

const SUCCESS_ACK_MS = 1500

/**
 * CSV export trigger backed by `useExportResults`. Disabled while
 * pending (so a second click cannot fire a parallel download) and
 * when no project is selected. On success, the label flips to
 * "Exported" for ~1.5s before reverting — the peak-end-rule
 * acknowledgment .impeccable.md asks for on completed operator
 * actions. On failure the mutation's error message renders inline
 * below the button.
 */
export function ExportButton({ filters, label = 'Export CSV', shortcutKey }: ExportButtonProps) {
  const selectedProjectId = useUiStore((s) => s.selectedProjectId)
  const exportMutation = useExportResults()
  const [justSucceeded, setJustSucceeded] = useState(false)

  useEffect(() => {
    if (!exportMutation.isSuccess) return
    setJustSucceeded(true)
    const t = setTimeout(() => setJustSucceeded(false), SUCCESS_ACK_MS)
    return () => clearTimeout(t)
  }, [exportMutation.isSuccess, exportMutation.submittedAt])

  const isDisabled = selectedProjectId === null || exportMutation.isPending
  const buttonLabel = exportMutation.isPending ? 'Exporting...' : justSucceeded ? 'Exported' : label
  const errorMessage =
    exportMutation.isError && exportMutation.error instanceof Error
      ? exportMutation.error.message
      : exportMutation.isError
        ? 'Export failed'
        : null

  const triggerExport = useCallback(() => {
    if (isDisabled) return
    exportMutation.mutate(filters)
  }, [exportMutation, filters, isDisabled])

  useKeyboardShortcut(shortcutKey ?? '', triggerExport, { disabled: !shortcutKey || isDisabled })

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
