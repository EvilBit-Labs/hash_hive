import { useState } from 'react'
import { Link } from 'react-router'

import { PermissionGuard } from '../components/features/permission-guard'
import { StatusBadge } from '../components/features/status-badge'
import { Button } from '../components/ui/button'
import { Checkbox } from '../components/ui/checkbox'
import { ConfirmDialog } from '../components/ui/confirm-dialog'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog'
import { EmptyState } from '../components/ui/empty-state'
import { ErrorBanner } from '../components/ui/error-banner'
import { Input } from '../components/ui/input'
import { PageHeader } from '../components/ui/page-header'
import { Table, TableBody, TableHead, Td, Th } from '../components/ui/table'
import {
  useArchiveSuperHashList,
  useCreateSuperHashList,
  useSuperHashLists,
} from '../hooks/use-super-hash-lists'
import { ApiError } from '../lib/api'
import { Permission } from '../lib/permissions'
import { useUiStore } from '../stores/ui'

/**
 * SuperHashlist list view (issue #101 U15). A SuperHashlist is a named,
 * read-time union over member hash lists. This page lists the project's
 * supers, offers create (name-only; membership is built up on the detail
 * page), and archive. Mutate controls are gated on `RESOURCE_UPLOAD`
 * (admin/contributor), mirroring the backend's `requireMembershipRole`.
 */
export function SuperHashListsPage() {
  const selectedProjectId = useUiStore((s) => s.selectedProjectId)
  const [showArchived, setShowArchived] = useState(false)
  const {
    superHashLists: supers,
    total,
    isLoading,
    isError,
    error,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useSuperHashLists({ showArchived })
  const [createOpen, setCreateOpen] = useState(false)
  const [archiveTarget, setArchiveTarget] = useState<{ id: number; name: string } | null>(null)
  const archive = useArchiveSuperHashList()
  const [archiveError, setArchiveError] = useState<string | null>(null)

  const confirmArchive = async () => {
    if (!archiveTarget) return
    setArchiveError(null)
    try {
      await archive.mutateAsync(archiveTarget.id)
      setArchiveTarget(null)
    } catch (err) {
      if (err instanceof ApiError) setArchiveError(err.message)
      else if (err instanceof Error) setArchiveError(err.message)
      else setArchiveError('Failed to archive super hash list.')
    }
  }

  if (!selectedProjectId) {
    return (
      <div className="space-y-4">
        <PageHeader>Super Hash Lists</PageHeader>
        <EmptyState message="Select a project to view its super hash lists." />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <PageHeader>Super Hash Lists</PageHeader>
        <div className="flex items-center gap-2">
          <label
            htmlFor="show-archived-supers"
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
          >
            <Checkbox
              id="show-archived-supers"
              checked={showArchived}
              onCheckedChange={(checked) => setShowArchived(checked === true)}
            />
            Show archived
          </label>
          <PermissionGuard permission={Permission.RESOURCE_UPLOAD}>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              New Super Hash List
            </Button>
          </PermissionGuard>
        </div>
      </div>

      <p className="max-w-prose text-xs text-muted-foreground">
        A super hash list is a named union over several member hash lists. Target one from a
        campaign to fan out one typed sub-campaign per member, with cracks deduplicated across the
        union.
      </p>

      {isError && (
        <ErrorBanner
          message={error instanceof Error ? error.message : 'Failed to load super hash lists.'}
        />
      )}
      {archiveError && <ErrorBanner message={archiveError} />}

      {isLoading ? (
        <EmptyState message="Loading super hash lists..." />
      ) : supers.length === 0 ? (
        <EmptyState message="No super hash lists yet. Create one to union several hash lists into a single campaign target." />
      ) : (
        <Table>
          <TableHead>
            <tr>
              <Th>Name</Th>
              <Th>Status</Th>
              <Th>Created</Th>
              <Th>
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </TableHead>
          <TableBody>
            {supers.map((sup) => (
              <tr key={sup.id} className="border-b border-surface-0/50 hover:bg-surface-0/40">
                <Td className="text-sm font-medium text-foreground">
                  <Link
                    to={`/super-hash-lists/${sup.id}`}
                    className="hover:text-primary hover:underline"
                  >
                    {sup.name}
                  </Link>
                </Td>
                <Td>
                  <StatusBadge status={sup.archivedAt ? 'archived' : 'active'} />
                </Td>
                <Td className="text-xs text-muted-foreground">
                  {new Date(sup.createdAt).toLocaleDateString()}
                </Td>
                <Td className="text-right">
                  <div className="flex items-center justify-end gap-3">
                    <Link
                      to={`/super-hash-lists/${sup.id}`}
                      className="text-xs text-muted-foreground hover:text-foreground hover:underline"
                    >
                      Manage
                    </Link>
                    {!sup.archivedAt && (
                      <PermissionGuard permission={Permission.RESOURCE_UPLOAD}>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setArchiveTarget({ id: sup.id, name: sup.name })}
                          aria-label={`Archive ${sup.name}`}
                        >
                          Archive
                        </Button>
                      </PermissionGuard>
                    )}
                  </div>
                </Td>
              </tr>
            ))}
          </TableBody>
        </Table>
      )}

      {!isLoading && !isError && supers.length > 0 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            Showing {supers.length} of {total}
          </span>
          {hasNextPage && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void fetchNextPage()}
              disabled={isFetchingNextPage}
            >
              {isFetchingNextPage ? 'Loading...' : 'Load more'}
            </Button>
          )}
        </div>
      )}

      {createOpen && <CreateSuperDialog onClose={() => setCreateOpen(false)} />}

      <ConfirmDialog
        open={archiveTarget !== null}
        title="Archive super hash list?"
        message={
          archiveTarget
            ? `"${archiveTarget.name}" will be hidden from the active list. Member hash lists stay untouched and independently targetable.`
            : ''
        }
        confirmLabel="Archive"
        destructive
        busy={archive.isPending}
        onConfirm={confirmArchive}
        onCancel={() => setArchiveTarget(null)}
      />
    </div>
  )
}

function CreateSuperDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const create = useCreateSuperHashList()

  const handleCreate = async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Name is required.')
      return
    }
    setError(null)
    try {
      await create.mutateAsync({ name: trimmed })
      onClose()
    } catch (err) {
      if (err instanceof ApiError) setError(err.message)
      else if (err instanceof Error) setError(err.message)
      else setError('Failed to create super hash list.')
    }
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New Super Hash List</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <label htmlFor="super-name" className="text-xs font-medium text-muted-foreground">
            Name
          </label>
          <Input
            id="super-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Q3 Domain Dumps"
          />
          <p className="text-xs text-muted-foreground">
            Add member hash lists after creating it from the detail page.
          </p>
          {error && <ErrorBanner message={error} />}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={create.isPending}>
            {create.isPending ? 'Creating...' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
