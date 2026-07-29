import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router'

import { PermissionGuard } from '../components/features/permission-guard'
import { StatusBadge } from '../components/features/status-badge'
import { Button } from '../components/ui/button'
import { EmptyState } from '../components/ui/empty-state'
import { ErrorBanner } from '../components/ui/error-banner'
import { Input } from '../components/ui/input'
import { PageHeader } from '../components/ui/page-header'
import { useHashLists } from '../hooks/use-resources'
import {
  useAddSuperMember,
  useRemoveSuperMember,
  useRenameSuperHashList,
  useSuperHashListDetail,
} from '../hooks/use-super-hash-lists'
import { ApiError } from '../lib/api'
import { Permission } from '../lib/permissions'
import { useUiStore } from '../stores/ui'

/**
 * SuperHashlist detail + membership editor (issue #101 U15). Shows the super's
 * members (resolved to hash-list names), a picker to add project hash lists not
 * already in the union, and per-member removal. Mutate controls gate on
 * `RESOURCE_UPLOAD` (admin/contributor) — a project viewer sees the membership
 * read-only, mirroring the backend's `requireMembershipRole` gate.
 *
 * The server harvests / reconciles membership server-side; the client only
 * reflects the updated `memberIds` returned by each mutation (via cache
 * invalidation), never trying to model the harvest itself.
 */
export function SuperHashListDetailPage() {
  const params = useParams<{ id: string }>()
  const selectedProjectId = useUiStore((s) => s.selectedProjectId)
  const id = Number(params.id)
  const validId = Number.isInteger(id) && id > 0

  const { data, isLoading, isError, error } = useSuperHashListDetail(validId ? id : 0)
  const hashListsQuery = useHashLists()

  const addMember = useAddSuperMember(id)
  const removeMember = useRemoveSuperMember(id)
  const [mutationError, setMutationError] = useState<string | null>(null)

  const hashListNameById = useMemo(() => {
    const map = new Map<number, string>()
    for (const hl of hashListsQuery.data?.hashLists ?? []) {
      map.set(hl.id, hl.name)
    }
    return map
  }, [hashListsQuery.data])

  if (!validId) {
    return (
      <div className="space-y-4">
        <BackLink />
        <EmptyState message="Invalid super hash list id." />
      </div>
    )
  }
  if (!selectedProjectId) {
    return (
      <div className="space-y-4">
        <BackLink />
        <EmptyState message="Select a project first." />
      </div>
    )
  }
  if (isLoading) {
    return (
      <div className="space-y-4">
        <BackLink />
        <EmptyState message="Loading super hash list..." />
      </div>
    )
  }
  if (isError) {
    return (
      <div className="space-y-4">
        <BackLink />
        <ErrorBanner message={error instanceof Error ? error.message : 'Failed to load.'} />
      </div>
    )
  }
  if (!data?.superHashList) {
    return (
      <div className="space-y-4">
        <BackLink />
        <EmptyState message="Super hash list not found." />
      </div>
    )
  }

  const sup = data.superHashList
  const memberIds = sup.memberIds
  const isArchived = sup.archivedAt !== null

  const projectHashLists = hashListsQuery.data?.hashLists ?? []
  const eligible = projectHashLists.filter((hl) => !memberIds.includes(hl.id))

  const runMutation = async (fn: () => Promise<unknown>) => {
    setMutationError(null)
    try {
      await fn()
    } catch (err) {
      if (err instanceof ApiError) setMutationError(err.message)
      else if (err instanceof Error) setMutationError(err.message)
      else setMutationError('Membership update failed.')
    }
  }

  return (
    <div className="space-y-6">
      <BackLink />

      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <PageHeader>{sup.name}</PageHeader>
            <StatusBadge status={isArchived ? 'archived' : 'active'} />
          </div>
          <p className="font-mono text-xs text-muted-foreground">
            #{sup.id} · {memberIds.length} member{memberIds.length === 1 ? '' : 's'}
          </p>
        </div>
        <PermissionGuard permission={Permission.CAMPAIGN_CREATE}>
          {!isArchived && (
            <Link
              to="/campaigns/new"
              className="text-xs text-muted-foreground hover:text-foreground hover:underline"
            >
              Target in a campaign
            </Link>
          )}
        </PermissionGuard>
      </div>

      <PermissionGuard permission={Permission.RESOURCE_UPLOAD}>
        {!isArchived && <RenameSection id={id} currentName={sup.name} />}
      </PermissionGuard>

      {mutationError && <ErrorBanner message={mutationError} />}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-foreground">Members</h2>
        <p className="max-w-prose text-xs text-muted-foreground">
          A super hash list needs at least two members before it can be targeted by a campaign.
          Members stay independently targetable by their own campaigns.
        </p>

        {memberIds.length === 0 ? (
          <EmptyState message="No members yet. Add hash lists below to build the union." />
        ) : (
          <ul className="divide-y divide-surface-0/50 rounded border border-surface-0/50">
            {memberIds.map((memberId) => (
              <li key={memberId} className="flex items-center justify-between px-3 py-2">
                <span className="text-sm text-foreground">
                  {hashListNameById.get(memberId) ?? (
                    <span className="font-mono text-muted-foreground">Hash list #{memberId}</span>
                  )}
                </span>
                <PermissionGuard permission={Permission.RESOURCE_UPLOAD}>
                  {!isArchived && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={removeMember.isPending}
                      onClick={() => void runMutation(() => removeMember.mutateAsync(memberId))}
                      aria-label={`Remove ${hashListNameById.get(memberId) ?? `hash list #${memberId}`}`}
                    >
                      Remove
                    </Button>
                  )}
                </PermissionGuard>
              </li>
            ))}
          </ul>
        )}
      </section>

      {!isArchived && (
        <PermissionGuard permission={Permission.RESOURCE_UPLOAD}>
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-foreground">Add members</h2>
            {eligible.length === 0 ? (
              <EmptyState message="Every project hash list is already a member." />
            ) : (
              <ul className="divide-y divide-surface-0/50 rounded border border-surface-0/50">
                {eligible.map((hl) => (
                  <li key={hl.id} className="flex items-center justify-between px-3 py-2">
                    <span className="text-sm text-foreground">{hl.name}</span>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={addMember.isPending}
                      onClick={() =>
                        void runMutation(() => addMember.mutateAsync({ hashListId: hl.id }))
                      }
                      aria-label={`Add ${hl.name}`}
                    >
                      Add
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </PermissionGuard>
      )}
    </div>
  )
}

function BackLink() {
  return (
    <Link
      to="/super-hash-lists"
      className="text-xs text-muted-foreground hover:text-foreground hover:underline"
    >
      &larr; Back to super hash lists
    </Link>
  )
}

function RenameSection({ id, currentName }: { id: number; currentName: string }) {
  const [name, setName] = useState(currentName)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const rename = useRenameSuperHashList(id)

  const dirty = name.trim() !== currentName && name.trim().length > 0

  const handleRename = async () => {
    const trimmed = name.trim()
    if (!trimmed || trimmed === currentName) return
    setError(null)
    setSaved(false)
    try {
      await rename.mutateAsync({ name: trimmed })
      setSaved(true)
    } catch (err) {
      if (err instanceof ApiError) setError(err.message)
      else if (err instanceof Error) setError(err.message)
      else setError('Rename failed.')
    }
  }

  return (
    <section className="space-y-2">
      <label htmlFor="super-rename" className="text-xs font-medium text-muted-foreground">
        Rename
      </label>
      <div className="flex gap-2">
        <Input
          id="super-rename"
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            setSaved(false)
          }}
          className="max-w-sm"
        />
        <Button size="sm" onClick={handleRename} disabled={!dirty || rename.isPending}>
          {rename.isPending ? 'Saving...' : 'Save'}
        </Button>
      </div>
      {saved && <p className="text-xs text-success">Name updated.</p>}
      {error && <ErrorBanner message={error} />}
    </section>
  )
}
