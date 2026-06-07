import { useState } from 'react'

import { CrackerUploadModal } from '../components/features/cracker-upload-modal'
import { PermissionGuard } from '../components/features/permission-guard'
import { Button } from '../components/ui/button'
import { ConfirmDialog } from '../components/ui/confirm-dialog'
import { EmptyState } from '../components/ui/empty-state'
import { ErrorBanner } from '../components/ui/error-banner'
import { PageHeader } from '../components/ui/page-header'
import { Table, TableBody, TableHead, TableRow, Td, Th } from '../components/ui/table'
import {
  type CrackerBinary,
  useCrackerBinaries,
  useDeleteCrackerBinary,
  useUpdateCrackerBinary,
} from '../hooks/use-crackers'
import { Permission } from '../lib/permissions'

const ENGINES = ['', 'hashcat', 'john'] as const
type EngineFilter = (typeof ENGINES)[number]

function formatFileSize(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return '-'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`
}

function formatDate(iso: string): string {
  // `new Date(...)` does not throw on invalid input — it returns a Date
  // whose internal time is NaN. The previous try/catch never triggered
  // and the UI showed "Invalid Date". Validate via getTime() instead.
  if (!iso) return '-'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleDateString()
}

export function CrackersPage() {
  return (
    <PermissionGuard
      permission={Permission.CRACKER_MANAGE}
      fallback={
        <div className="space-y-4">
          <PageHeader>Cracker Binaries</PageHeader>
          <EmptyState message="You do not have permission to manage cracker binaries." />
        </div>
      }
    >
      <CrackersAdminView />
    </PermissionGuard>
  )
}

function CrackersAdminView() {
  const [engineFilter, setEngineFilter] = useState<EngineFilter>('')
  const [includeInactive, setIncludeInactive] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<CrackerBinary | null>(null)

  const queryArgs: Parameters<typeof useCrackerBinaries>[0] = { includeInactive }
  if (engineFilter) {
    queryArgs.engine = engineFilter
  }
  const { data: binaries, isLoading, error: queryError, refetch } = useCrackerBinaries(queryArgs)

  const updateBinary = useUpdateCrackerBinary({ onError: setActionError })
  const deleteBinary = useDeleteCrackerBinary({ onError: setActionError })

  const handleToggleActive = (binary: CrackerBinary) => {
    setActionError(null)
    updateBinary.mutate({ id: binary.id, isActive: !binary.isActive })
  }

  const handleConfirmDelete = () => {
    if (!pendingDelete) return
    setActionError(null)
    deleteBinary.mutate(pendingDelete.id, {
      onSettled: () => setPendingDelete(null),
    })
  }

  const queryErrorMessage =
    queryError instanceof Error
      ? queryError.message
      : queryError
        ? 'Failed to load cracker binaries'
        : null

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <PageHeader>Cracker Binaries</PageHeader>
        <Button onClick={() => setUploadOpen(true)}>Upload Binary</Button>
      </div>

      {queryErrorMessage && <ErrorBanner message={queryErrorMessage} />}
      {actionError && <ErrorBanner message={actionError} />}

      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-1.5">
          {ENGINES.map((value) => (
            <Button
              key={value || 'all'}
              variant={engineFilter === value ? 'primary' : 'secondary'}
              onClick={() => setEngineFilter(value)}
              className="text-xs"
            >
              {value || 'All engines'}
            </Button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            aria-label="Include inactive cracker binaries"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
          />
          Include inactive
        </label>
      </div>

      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading...</p>
      ) : !binaries || binaries.length === 0 ? (
        <EmptyState
          message="No cracker binaries registered yet."
          action={<Button onClick={() => setUploadOpen(true)}>Upload Binary</Button>}
        />
      ) : (
        <Table>
          <TableHead>
            <TableRow>
              <Th>Engine</Th>
              <Th>Version</Th>
              <Th>Platform</Th>
              <Th>Status</Th>
              <Th>Size</Th>
              <Th>Uploaded</Th>
              <Th>Actions</Th>
            </TableRow>
          </TableHead>
          <TableBody>
            {binaries.map((binary) => {
              // fileRef is jsonb; narrow at use rather than asserting a shape
              // so the no-unsafe-type-assertion lint stays satisfied.
              const fileRefValue = binary.fileRef
              const fileSize =
                fileRefValue !== null &&
                typeof fileRefValue === 'object' &&
                'size' in fileRefValue &&
                typeof fileRefValue.size === 'number'
                  ? fileRefValue.size
                  : undefined
              return (
                <TableRow key={binary.id}>
                  <Td>{binary.engine}</Td>
                  <Td>{binary.version}</Td>
                  <Td>{binary.platform}</Td>
                  <Td>{binary.isActive ? 'Active' : 'Inactive'}</Td>
                  <Td>{formatFileSize(fileSize)}</Td>
                  <Td>{formatDate(binary.createdAt)}</Td>
                  <Td>
                    <div className="flex gap-1.5">
                      <Button
                        variant="secondary"
                        onClick={() => handleToggleActive(binary)}
                        disabled={updateBinary.isPending}
                        className="text-xs"
                      >
                        {binary.isActive ? 'Deactivate' : 'Activate'}
                      </Button>
                      <Button
                        variant="destructive"
                        onClick={() => {
                          setActionError(null)
                          setPendingDelete(binary)
                        }}
                        disabled={deleteBinary.isPending}
                        className="text-xs"
                      >
                        Delete
                      </Button>
                    </div>
                  </Td>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}

      <CrackerUploadModal
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onSuccess={() => {
          setUploadOpen(false)
          void refetch()
        }}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete cracker binary?"
        message={
          pendingDelete
            ? `This permanently removes the ${pendingDelete.engine} ${pendingDelete.version} binary for ${pendingDelete.platform}, including the stored file.`
            : ''
        }
        confirmLabel="Delete"
        destructive
        busy={deleteBinary.isPending}
        onConfirm={handleConfirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  )
}
