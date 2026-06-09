import { type ExportResultsFilters, useExportResults } from '../../../hooks/use-export-results'
import { useUiStore } from '../../../stores/ui'
import { Button } from '../../ui/button'

interface ExportButtonProps {
  readonly filters: ExportResultsFilters
  readonly label?: string
}

/**
 * CSV export trigger backed by `useExportResults`. While the mutation
 * is pending we swap label text and disable the button so a second
 * click cannot fire a parallel download. When no project is selected
 * the button is disabled (the underlying `/results` query is gated
 * the same way — exporting nothing-scope is nonsensical).
 */
export function ExportButton({ filters, label = 'Export CSV' }: ExportButtonProps) {
  const selectedProjectId = useUiStore((s) => s.selectedProjectId)
  const exportMutation = useExportResults()

  const isDisabled = selectedProjectId === null || exportMutation.isPending

  return (
    <Button
      variant="secondary"
      size="sm"
      disabled={isDisabled}
      onClick={() => exportMutation.mutate(filters)}
    >
      {exportMutation.isPending ? 'Exporting...' : label}
    </Button>
  )
}
