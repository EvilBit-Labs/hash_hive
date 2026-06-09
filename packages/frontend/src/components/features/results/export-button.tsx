import { type ExportResultsFilters, useExportResults } from '../../../hooks/use-export-results'
import { useUiStore } from '../../../stores/ui'
import { Button } from '../../ui/button'

interface ExportButtonProps {
  readonly filters: ExportResultsFilters
  readonly label?: string
}

/**
 * CSV export trigger backed by `useExportResults`. Disabled while
 * pending (so a second click cannot fire a parallel download) and
 * when no project is selected (the underlying query is scoped the
 * same way). On failure the mutation's error message renders inline
 * below the button so the operator sees something other than the
 * spinner reverting to "Export CSV".
 */
export function ExportButton({ filters, label = 'Export CSV' }: ExportButtonProps) {
  const selectedProjectId = useUiStore((s) => s.selectedProjectId)
  const exportMutation = useExportResults()

  const isDisabled = selectedProjectId === null || exportMutation.isPending
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
        {exportMutation.isPending ? 'Exporting...' : label}
      </Button>
      {errorMessage && (
        <span role="alert" className="text-xs text-destructive">
          {errorMessage}
        </span>
      )}
    </div>
  )
}
