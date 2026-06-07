import { motion, useReducedMotion } from 'motion/react'
import { type KeyboardEvent, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'

import { HashTypeDetectModal } from '../components/features/hash-type-detect-modal'
import { PermissionGuard } from '../components/features/permission-guard'
import { ResourceUploadModal } from '../components/features/resource-upload-modal'
import { StatusBadge } from '../components/features/status-badge'
import { Button } from '../components/ui/button'
import { ConfirmDialog } from '../components/ui/confirm-dialog'
import { EmptyState } from '../components/ui/empty-state'
import { ErrorBanner } from '../components/ui/error-banner'
import { PageHeader } from '../components/ui/page-header'
import { Table, TableBody, TableHead, TableRow, Td, Th } from '../components/ui/table'
import {
  useDeleteResource,
  useHashLists,
  useHashTypes,
  useMasklists,
  useRulelists,
  useWordlists,
} from '../hooks/use-resources'
import { Permission } from '../lib/permissions'
import { cn } from '../lib/utils'
import { useUiStore } from '../stores/ui'

// Row-pulse acknowledgment timing. Motion's `transition.duration` takes
// seconds, the parent's clear-after-N timer takes ms; deriving the ms
// value from the seconds value prevents the two from drifting.
const ROW_PULSE_DURATION_S = 1.2
const ROW_PULSE_MS = ROW_PULSE_DURATION_S * 1000

// Brand-warm exponential ease-out (mirrors `--ease-out-expo` in
// neighboring components). Cubic-bezier expressed as Motion expects.
const EASE_OUT_EXPO = [0.16, 1, 0.3, 1] as const

// Pulse + hover color tokens live on the motion.tr className as
// inline arbitrary CSS variables (per motion.dev's React + Tailwind
// pattern: theme references stay declarative on the element, Motion
// dereferences via var() in animate/whileHover). The colors track
// theme changes because they resolve --primary / --surface-0 at
// render time.
const ROW_PULSE_VARS =
  '[--pulse-on:hsl(var(--primary)/0.22)] ' +
  '[--pulse-quiet:hsl(var(--primary)/0.1)] ' +
  '[--row-hover:hsl(var(--surface-0)/0.2)]'

// Hyphen for unknown/zero so empty uploads and pre-upload rows don't
// pretend to be "0 B".
function formatFileSize(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '-'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`
}

type Tab = 'hash-lists' | 'wordlists' | 'rulelists' | 'masklists'

type UploadableTab = Tab

const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'hash-lists', label: 'Hash Lists' },
  { id: 'wordlists', label: 'Wordlists' },
  { id: 'rulelists', label: 'Rulelists' },
  { id: 'masklists', label: 'Masklists' },
] as const

// Delete-target snapshot driven by row clicks. Stored at the page level
// so the confirmation modal (wired in U4) is a single instance shared
// across tabs - opening it from a row sets the target; closing clears.
interface DeleteTarget {
  type: UploadableTab
  id: number
  name: string
}

export function ResourcesPage() {
  const selectedProjectId = useUiStore((s) => s.selectedProjectId)
  const [activeTab, setActiveTab] = useState<Tab>('hash-lists')
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const [detectOpen, setDetectOpen] = useState(false)
  // Hash list id that just had a type applied. The matching row in
  // the Hash Lists tab gets a brief peach acknowledgment pulse so the
  // operator sees where their commit landed; cleared after the
  // animation duration.
  const [justAppliedListId, setJustAppliedListId] = useState<number | null>(null)

  const handleDelete = (type: UploadableTab, id: number, name: string) => {
    setDeleteTarget({ type, id, name })
  }

  const handleApplied = (hashListId: number) => {
    setJustAppliedListId(hashListId)
    // Snap to the hash-lists tab so the row the operator just touched
    // is on screen. They came from the page-level Detect Hash Type
    // button, so the destination tab is the same regardless of which
    // tab they were on.
    setActiveTab('hash-lists')
  }

  useEffect(() => {
    if (justAppliedListId === null) return
    const timeoutId = window.setTimeout(() => setJustAppliedListId(null), ROW_PULSE_MS)
    return () => window.clearTimeout(timeoutId)
  }, [justAppliedListId])

  if (!selectedProjectId) {
    return (
      <div className="space-y-4">
        <PageHeader>Resources</PageHeader>
        <EmptyState message="Select a project to view resources." />
      </div>
    )
  }

  const handleTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const currentIndex = TABS.findIndex((t) => t.id === activeTab)
    let nextIndex: number | null = null

    switch (e.key) {
      case 'ArrowRight':
        nextIndex = (currentIndex + 1) % TABS.length
        break
      case 'ArrowLeft':
        nextIndex = (currentIndex - 1 + TABS.length) % TABS.length
        break
      case 'Home':
        nextIndex = 0
        break
      case 'End':
        nextIndex = TABS.length - 1
        break
      default:
        return
    }

    e.preventDefault()
    const nextTab = TABS[nextIndex]
    if (nextTab) {
      setActiveTab(nextTab.id)
      document.getElementById(`tab-${nextTab.id}`)?.focus()
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeader>Resources</PageHeader>
        <Button variant="secondary" size="sm" onClick={() => setDetectOpen(true)}>
          Detect Hash Type
        </Button>
      </div>

      <div
        role="tablist"
        aria-label="Resource types"
        className="flex gap-1 border-b border-surface-0/50"
      >
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={`tabpanel-${tab.id}`}
            id={`tab-${tab.id}`}
            tabIndex={activeTab === tab.id ? 0 : -1}
            onClick={() => setActiveTab(tab.id)}
            onKeyDown={handleTabKeyDown}
            className={cn(
              'border-b-2 px-3 py-2 text-xs font-medium transition-colors',
              activeTab === tab.id
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`tabpanel-${activeTab}`} aria-labelledby={`tab-${activeTab}`}>
        {activeTab === 'hash-lists' && (
          <HashListsTab onDelete={handleDelete} justAppliedListId={justAppliedListId} />
        )}
        {activeTab === 'wordlists' && <ResourceListTab type="wordlists" onDelete={handleDelete} />}
        {activeTab === 'rulelists' && <ResourceListTab type="rulelists" onDelete={handleDelete} />}
        {activeTab === 'masklists' && <ResourceListTab type="masklists" onDelete={handleDelete} />}
      </div>

      {deleteTarget !== null && (
        <ResourceDeleteDialog target={deleteTarget} onClose={() => setDeleteTarget(null)} />
      )}
      {/* Lazy-mount: the detect modal pulls /hash-lists and /hash-types
          via React Query the moment it's rendered. Mounting only when
          the operator clicks "Detect Hash Type" defers those fetches
          until they're actually needed. */}
      {detectOpen && (
        <HashTypeDetectModal open onClose={() => setDetectOpen(false)} onApplied={handleApplied} />
      )}
    </div>
  )
}

// React-Query's onSuccess cache invalidation in `useDeleteResource`
// refreshes the table, so no optimistic cache write is needed here.
function ResourceDeleteDialog({ target, onClose }: { target: DeleteTarget; onClose: () => void }) {
  const mutation = useDeleteResource(target.type)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const handleConfirm = () => {
    setErrorMessage(null)
    mutation.mutate(target.id, {
      onSuccess: () => onClose(),
      onError: (err) => {
        setErrorMessage(err instanceof Error ? err.message : 'Delete failed. Try again.')
      },
    })
  }

  return (
    <>
      <ConfirmDialog
        open
        title={`Delete ${target.name}?`}
        message={`This will permanently delete "${target.name}". This cannot be undone.`}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        destructive
        busy={mutation.isPending}
        onConfirm={handleConfirm}
        onCancel={onClose}
      />
      {errorMessage !== null && (
        <div className="fixed inset-x-0 bottom-6 z-[60] mx-auto max-w-md px-4">
          <ErrorBanner message={errorMessage} />
        </div>
      )}
    </>
  )
}

function UploadButton({ type }: { type: UploadableTab }) {
  const [open, setOpen] = useState(false)

  const labels: Record<UploadableTab, string> = {
    'hash-lists': 'Hash List',
    wordlists: 'Wordlist',
    rulelists: 'Rulelist',
    masklists: 'Masklist',
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        Upload {labels[type]}
      </Button>
      <ResourceUploadModal
        type={type}
        open={open}
        onClose={() => setOpen(false)}
        onSuccess={() => {}}
      />
    </>
  )
}

function HashListsTab({
  onDelete,
  justAppliedListId,
}: {
  onDelete: (type: UploadableTab, id: number, name: string) => void
  justAppliedListId: number | null
}) {
  const { data, isLoading } = useHashLists()
  const hashTypes = useHashTypes()
  const prefersReducedMotion = useReducedMotion()

  // hash_types.id → display name. The list endpoint returns
  // hashTypeId only; without this resolution the column would force
  // a per-row fetch. Map stays warm via React Query so the lookup is
  // free across re-renders.
  const hashTypeNameById = useMemo(() => {
    const map = new Map<number, string>()
    for (const ht of hashTypes.data?.hashTypes ?? []) {
      map.set(ht.id, ht.name)
    }
    return map
  }, [hashTypes.data])

  if (isLoading) return <EmptyState message="Loading..." />

  const hashLists = data?.hashLists ?? []

  return (
    <div className="space-y-4">
      <PermissionGuard permission={Permission.RESOURCE_UPLOAD}>
        <div className="flex justify-end">
          <UploadButton type="hash-lists" />
        </div>
      </PermissionGuard>

      {hashLists.length === 0 ? (
        <EmptyState message="No hash lists found." />
      ) : (
        <Table>
          <TableHead>
            <tr>
              <Th>Name</Th>
              <Th>Hash Type</Th>
              <Th>Size</Th>
              <Th>Status</Th>
              <Th>Hashes</Th>
              <Th>Cracked</Th>
              <Th>Progress</Th>
              <Th>Created</Th>
              <Th>
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </TableHead>
          <TableBody>
            {hashLists.map((hl) => {
              // The list endpoint doesn't currently aggregate counts;
              // the wire schema marks both fields optional. Default to
              // 0 and render the progress bar empty until a stats sweep
              // populates them on a future enhancement.
              const hashCount = hl.hashCount ?? 0
              const crackedCount = hl.crackedCount ?? 0
              const pct = hashCount > 0 ? (crackedCount / hashCount) * 100 : 0
              const hashTypeName =
                hl.hashTypeId !== null ? (hashTypeNameById.get(hl.hashTypeId) ?? null) : null
              const isJustApplied = hl.id === justAppliedListId
              // Animate backgroundColor (not box-shadow) on <tr>:
              // WebKit ignores box-shadow on table rows. Hover lives
              // in whileHover so it doesn't fight Motion's inline
              // animate style.
              const pulseAnimate = isJustApplied
                ? prefersReducedMotion
                  ? { backgroundColor: 'var(--pulse-quiet)' }
                  : { backgroundColor: ['var(--pulse-on)', 'transparent'] }
                : { backgroundColor: 'transparent' }
              return (
                <motion.tr
                  key={hl.id}
                  className={ROW_PULSE_VARS}
                  animate={pulseAnimate}
                  whileHover={{ backgroundColor: 'var(--row-hover)' }}
                  transition={{ duration: ROW_PULSE_DURATION_S, ease: [...EASE_OUT_EXPO] }}
                >
                  <Td className="text-sm font-medium text-foreground">
                    <Link
                      to={`/resources/hash-lists/${hl.id}`}
                      className="hover:text-primary hover:underline"
                    >
                      {hl.name}
                    </Link>
                  </Td>
                  <Td className="text-xs">
                    {hashTypeName !== null ? (
                      <span className="text-foreground">{hashTypeName}</span>
                    ) : (
                      <span className="text-overlay1">-</span>
                    )}
                  </Td>
                  <Td className="font-mono text-xs text-muted-foreground tabular-nums">
                    {formatFileSize(hl.fileRef?.size)}
                  </Td>
                  <Td>
                    <StatusBadge status={hl.status} />
                  </Td>
                  <Td className="font-mono text-xs tabular-nums">{hashCount}</Td>
                  <Td className="font-mono text-xs text-success tabular-nums">{crackedCount}</Td>
                  <Td>
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-20 rounded-full bg-surface-1">
                        <div
                          className="h-full rounded-full bg-primary transition-all"
                          style={{ width: `${Math.min(pct, 100)}%` }}
                        />
                      </div>
                      <span className="font-mono text-xs text-muted-foreground">
                        {pct.toFixed(0)}%
                      </span>
                    </div>
                  </Td>
                  <Td className="text-xs text-muted-foreground">
                    {new Date(hl.createdAt).toLocaleDateString()}
                  </Td>
                  <Td className="text-right">
                    <PermissionGuard permission={Permission.RESOURCE_UPLOAD}>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onDelete('hash-lists', hl.id, hl.name)}
                        aria-label={`Delete ${hl.name}`}
                      >
                        Delete
                      </Button>
                    </PermissionGuard>
                  </Td>
                </motion.tr>
              )
            })}
          </TableBody>
        </Table>
      )}
    </div>
  )
}

function useResourcesByType(type: 'wordlists' | 'rulelists' | 'masklists') {
  const wordlists = useWordlists({ enabled: type === 'wordlists' })
  const rulelists = useRulelists({ enabled: type === 'rulelists' })
  const masklists = useMasklists({ enabled: type === 'masklists' })

  const hookMap = { wordlists, rulelists, masklists }
  return hookMap[type]
}

function ResourceListTab({
  type,
  onDelete,
}: {
  type: 'wordlists' | 'rulelists' | 'masklists'
  onDelete: (type: UploadableTab, id: number, name: string) => void
}) {
  const { data, isLoading } = useResourcesByType(type)

  if (isLoading) return <EmptyState message="Loading..." />

  const resources = data?.resources ?? []

  return (
    <div className="space-y-4">
      <PermissionGuard permission={Permission.RESOURCE_UPLOAD}>
        <div className="flex justify-end">
          <UploadButton type={type} />
        </div>
      </PermissionGuard>

      {resources.length === 0 ? (
        <EmptyState message={`No ${type} found.`} />
      ) : (
        <Table>
          <TableHead>
            <tr>
              <Th>Name</Th>
              <Th>Size</Th>
              <Th>Status</Th>
              <Th>Created</Th>
              <Th>
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </TableHead>
          <TableBody>
            {resources.map((r) => (
              <TableRow key={r.id}>
                <Td className="text-sm font-medium text-foreground">{r.name}</Td>
                <Td className="font-mono text-xs text-muted-foreground tabular-nums">
                  {formatFileSize(r.fileSize ?? r.fileRef?.size)}
                </Td>
                <Td>
                  <StatusBadge status={r.status} />
                </Td>
                <Td className="text-xs text-muted-foreground">
                  {new Date(r.createdAt).toLocaleDateString()}
                </Td>
                <Td className="text-right">
                  <PermissionGuard permission={Permission.RESOURCE_UPLOAD}>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onDelete(type, r.id, r.name)}
                      aria-label={`Delete ${r.name}`}
                    >
                      Delete
                    </Button>
                  </PermissionGuard>
                </Td>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
