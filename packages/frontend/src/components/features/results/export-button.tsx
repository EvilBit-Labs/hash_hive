import { useEffect, useState } from 'react'

import { type ExportResultsFilters, useExportResults } from '../../../hooks/use-export-results'
import { useUiStore } from '../../../stores/ui'
import { Button } from '../../ui/button'

interface ExportButtonProps {
  readonly filters: ExportResultsFilters
  readonly label?: string
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
export function ExportButton({ filters, label = 'Export CSV' }: ExportButtonProps) {
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

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="secondary"
        size="sm"
        disabled={isDisabled}
        onClick={() => exportMutation.mutate(filters)}
      >
        {buttonLabel}
      </Button>
      {errorMessage && (
        <span role="alert" className="text-xs text-destructive">
          {errorMessage}
        </span>
      )}
    </div>
  )
}
