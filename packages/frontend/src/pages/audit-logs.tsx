/**
 * Audit Logs browse page (U10).
 *
 * Project-scoped, paginated, filterable audit history. Access is gated to
 * admin and contributor roles (R11) via the sidebar permission check and the
 * backend's own middleware - no redundant page-level guard needed (Crackers
 * follows the same nav-only gate pattern).
 *
 * Changes cell rendering follows the diff shape produced by U2:
 *   - `updated`  → `{ field: { old: value, new: value }, ... }`
 *   - `created`  → `{ field: { new: value }, ... }`
 *   - `deleted`  → `{ field: { old: value }, ... }`
 *   - `status_changed` → fromStatus/toStatus columns; inline, no accordion
 *   - `token_issued`   → changes is always null; static label
 */

import { AnimatePresence, motion } from 'motion/react'
import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router'

import { Button } from '../components/ui/button'
import { EmptyState } from '../components/ui/empty-state'
import { ErrorBanner } from '../components/ui/error-banner'
import { PageHeader } from '../components/ui/page-header'
import { Table, TableBody, TableHead, TableRow, Td, Th } from '../components/ui/table'
import { useAuditLogs } from '../hooks/use-audit-logs'
import { useCopyToClipboard } from '../hooks/use-copy-to-clipboard'
import { safeNonNegativeInt, safePositiveInt } from '../lib/search-params'
import { useUiStore } from '../stores/ui'

// ─── Constants ───────────────────────────────────────────────────────────────

const PAGE_SIZE = 50

const DEFAULT_DATE_RANGE = '30d'
const VALID_DATE_RANGE_VALUES = ['24h', '7d', '30d', 'all'] as const
type DateRangeKey = (typeof VALID_DATE_RANGE_VALUES)[number]

function isDateRangeKey(raw: string): raw is DateRangeKey {
  return (VALID_DATE_RANGE_VALUES as readonly string[]).includes(raw)
}

const HOURS_PER_DAY = 24
const MS_PER_HOUR = 60 * 60 * 1000
const DATE_RANGE_HOURS: Record<Exclude<DateRangeKey, 'all'>, number> = {
  '24h': 24,
  '7d': 7 * HOURS_PER_DAY,
  '30d': 30 * HOURS_PER_DAY,
}

/** Truncate long field values beyond this length for display. */
const FIELD_VALUE_DISPLAY_LIMIT = 80

// ─── Diff types ──────────────────────────────────────────────────────────────

interface FieldDiff {
  old?: unknown
  new?: unknown
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function safeDateRange(raw: string | null): DateRangeKey {
  if (raw && isDateRangeKey(raw)) return raw
  return DEFAULT_DATE_RANGE
}

function resolveDateWindow(range: DateRangeKey): { dateFrom?: string; dateTo?: string } {
  if (range === 'all') return {}
  const now = new Date()
  const hours = DATE_RANGE_HOURS[range]
  const from = new Date(now.getTime() - hours * MS_PER_HOUR)
  return { dateFrom: from.toISOString(), dateTo: now.toISOString() }
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'short',
    timeStyle: 'medium',
  })
}

function rawToString(raw: unknown): string {
  if (raw === null || raw === undefined) return ''
  if (typeof raw === 'string') return raw
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw)
  // Objects / arrays: serialize to JSON so the value is legible
  try {
    return JSON.stringify(raw)
  } catch {
    return '[object]'
  }
}

function truncateValue(raw: unknown): { display: string; full: string; truncated: boolean } {
  const full = rawToString(raw)
  if (full.length <= FIELD_VALUE_DISPLAY_LIMIT) return { display: full, full, truncated: false }
  return { display: `${full.slice(0, FIELD_VALUE_DISPLAY_LIMIT)}...`, full, truncated: true }
}

// ─── Copy button (sub-component) ─────────────────────────────────────────────

function CopyButton({ value }: { readonly value: string }) {
  const { copied, copyFailed, copy } = useCopyToClipboard()
  return (
    <button
      type="button"
      aria-label="Copy full value"
      title="Copy full value"
      onClick={() => copy(value)}
      className="ml-1 inline-flex items-center rounded px-1 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-surface-0/60 hover:text-foreground"
    >
      {copied ? 'Copied' : copyFailed ? 'Copy failed' : 'Copy'}
    </button>
  )
}

// ─── Field diff row ──────────────────────────────────────────────────────────

function FieldDiffRow({ name, diff }: { readonly name: string; readonly diff: FieldDiff }) {
  const hasOld = 'old' in diff
  const hasNew = 'new' in diff

  const oldMeta = hasOld ? truncateValue(diff.old) : null
  const newMeta = hasNew ? truncateValue(diff.new) : null

  return (
    <li className="grid grid-cols-[auto_1fr] gap-x-3 py-1 text-xs">
      <span className="font-mono text-muted-foreground">{name}</span>
      <span className="flex flex-wrap items-baseline gap-x-1">
        {hasOld && oldMeta && (
          <>
            <span className="font-mono text-warning/90 line-through">{oldMeta.display}</span>
            {oldMeta.truncated && <CopyButton value={oldMeta.full} />}
          </>
        )}
        {hasOld && hasNew && <span className="text-muted-foreground">→</span>}
        {hasNew && newMeta && (
          <>
            <span className="font-mono text-success/90">{newMeta.display}</span>
            {newMeta.truncated && <CopyButton value={newMeta.full} />}
          </>
        )}
      </span>
    </li>
  )
}

// ─── Changes cell ─────────────────────────────────────────────────────────────

interface ChangesCellProps {
  readonly action: string
  readonly fromStatus: string | null
  readonly toStatus: string | null
  readonly changes: Record<string, unknown> | null
  readonly rowId: number
  readonly expandedId: number | null
  readonly onToggle: (id: number) => void
}

function ChangesCell({
  action,
  fromStatus,
  toStatus,
  changes,
  rowId,
  expandedId,
  onToggle,
}: ChangesCellProps) {
  // token_issued: changes is always null by design (R6)
  if (action === 'token_issued') {
    return <span className="text-xs text-muted-foreground">Token issued - no field diff</span>
  }

  // status_changed: render inline from top-level columns, no accordion
  if (action === 'status_changed') {
    return (
      <span className="text-xs">
        <span className="font-mono text-muted-foreground">status</span>
        {': '}
        <span className="font-mono text-warning/90">{fromStatus ?? '-'}</span>
        <span className="text-muted-foreground">{' -> '}</span>
        <span className="font-mono text-success/90">{toStatus ?? '-'}</span>
      </span>
    )
  }

  // No changes recorded
  if (!changes || Object.keys(changes).length === 0) {
    return <span className="text-xs text-muted-foreground">-</span>
  }

  // Oversized payload: recorder replaced the diff with a truncation marker
  if (changes['_truncated'] === true) {
    return (
      <span className="text-xs text-muted-foreground italic">
        Diff truncated - payload too large
      </span>
    )
  }

  const fieldEntries = Object.entries(changes)
  const fieldCount = fieldEntries.length
  const isExpanded = expandedId === rowId

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={() => onToggle(rowId)}
        aria-expanded={isExpanded}
        className="inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-surface-0/60 hover:text-foreground"
      >
        <span className="rounded bg-surface-0 px-1.5 py-0.5 font-mono text-[10px] tabular-nums">
          {fieldCount}
        </span>
        {fieldCount === 1 ? 'field changed' : 'fields changed'}
        <span
          aria-hidden="true"
          className={`inline-block transition-transform ${isExpanded ? 'rotate-90' : ''}`}
        >
          {'>'}
        </span>
      </button>

      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            key="diff"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: 'easeInOut' }}
            style={{ overflow: 'hidden' }}
          >
            <ul className="mt-1 space-y-0 rounded border border-surface-0/60 bg-crust/30 px-3 py-2">
              {fieldEntries.map(([field, rawDiff]) => {
                const diff: FieldDiff =
                  rawDiff !== null && typeof rawDiff === 'object' ? (rawDiff as FieldDiff) : {}
                return <FieldDiffRow key={field} name={field} diff={diff} />
              })}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ─── Entity link helper ───────────────────────────────────────────────────────

function entityLink(entityType: string, entityId: number): string {
  switch (entityType) {
    case 'campaign':
      return `/campaigns/${entityId}`
    case 'agent':
      return `/agents/${entityId}`
    case 'hash_list':
      return `/resources/hash-lists/${entityId}`
    default:
      return ''
  }
}

interface EntityCellProps {
  readonly action: string
  readonly entityType: string
  readonly entityId: number
  readonly entityLabel: string | undefined
}

function EntityCell({ action, entityType, entityId, entityLabel }: EntityCellProps) {
  // token_issued: entityId is the enrollment-token PK, not an agent row.
  // Rendering a link to /agents/<id> would be incorrect — show a static label.
  if (action === 'token_issued') {
    return <span className="text-xs">Enrollment token</span>
  }
  const display = entityLabel ?? `${entityType} #${entityId}`
  const href = entityLink(entityType, entityId)
  if (href) {
    return (
      <Link to={href} className="text-xs text-primary hover:underline">
        {display}
      </Link>
    )
  }
  return <span className="text-xs">{display}</span>
}

// ─── Page ────────────────────────────────────────────────────────────────────

export function AuditLogsPage() {
  const selectedProjectId = useUiStore((s) => s.selectedProjectId)
  const [searchParams, setSearchParams] = useSearchParams()
  const [expandedRowId, setExpandedRowId] = useState<number | null>(null)

  // --- Parse URL state ---

  const entityType = searchParams.get('entityType') ?? undefined
  const entityId = safePositiveInt(searchParams.get('entityId'))
  const actorType = searchParams.get('actorType') ?? undefined
  const action = searchParams.get('action') ?? undefined
  const dateRange = safeDateRange(searchParams.get('dateRange'))
  const offset = safeNonNegativeInt(searchParams.get('offset'))

  const { dateFrom, dateTo } = useMemo(() => resolveDateWindow(dateRange), [dateRange])

  const hasActiveFilters =
    !!entityType ||
    entityId !== undefined ||
    !!actorType ||
    !!action ||
    dateRange !== DEFAULT_DATE_RANGE

  // --- Query ---

  const { data, isLoading, isError } = useAuditLogs({
    ...(entityType !== undefined && { entityType }),
    ...(entityId !== undefined && { entityId }),
    ...(actorType !== undefined && { actorType }),
    ...(action !== undefined && { action }),
    ...(dateFrom !== undefined && { dateFrom }),
    ...(dateTo !== undefined && { dateTo }),
    limit: PAGE_SIZE,
    offset,
  })

  // --- Pagination ---

  const total = data?.total ?? 0
  const hasPrev = offset > 0
  const hasNext = offset + PAGE_SIZE < total

  const rangeStart = Math.min(offset + 1, total)
  const rangeEnd = Math.min(offset + PAGE_SIZE, total)

  // Guard against stale URL offset beyond total
  const hasOutOfRangeOffset = total > 0 && offset >= total

  // --- Filter helpers ---

  function setFilter(key: string, value: string | undefined) {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (value) {
          next.set(key, value)
        } else {
          next.delete(key)
        }
        next.delete('offset')
        return next
      },
      { replace: true }
    )
    setExpandedRowId(null)
  }

  function clearFilters() {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete('entityType')
        next.delete('entityId')
        next.delete('actorType')
        next.delete('action')
        next.delete('dateRange')
        next.delete('offset')
        return next
      },
      { replace: true }
    )
    setExpandedRowId(null)
  }

  function goToPage(newOffset: number) {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.set('offset', String(newOffset))
        return next
      },
      { replace: true }
    )
    setExpandedRowId(null)
  }

  function handleToggle(id: number) {
    setExpandedRowId((prev) => (prev === id ? null : id))
  }

  // --- No project selected ---

  if (!selectedProjectId) {
    return (
      <div className="space-y-6">
        <PageHeader>Audit Logs</PageHeader>
        <EmptyState message="Select a project to view audit logs." />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader>Audit Logs</PageHeader>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3">
        {/* Entity type filter - hidden when arriving via deep link with entityId */}
        {entityId === undefined && (
          <div className="flex flex-col gap-1">
            <label htmlFor="filter-entity-type" className="text-xs text-muted-foreground">
              Entity type
            </label>
            <select
              id="filter-entity-type"
              aria-label="Filter by entity type"
              value={entityType ?? ''}
              onChange={(e) => setFilter('entityType', e.target.value || undefined)}
              className="rounded border border-surface-0 bg-mantle px-2.5 py-1.5 text-xs text-foreground focus:ring-1 focus:ring-primary/50 focus:outline-none"
            >
              <option value="">All entities</option>
              <option value="project">Project</option>
              <option value="campaign">Campaign</option>
              <option value="attack">Attack</option>
              <option value="hash_list">Hash List</option>
              <option value="word_list">Word List</option>
              <option value="rule_list">Rule List</option>
              <option value="mask_list">Mask List</option>
              <option value="agent">Agent</option>
            </select>
          </div>
        )}

        {/* Actor type filter */}
        <div className="flex flex-col gap-1">
          <label htmlFor="filter-actor-type" className="text-xs text-muted-foreground">
            Actor type
          </label>
          <select
            id="filter-actor-type"
            aria-label="Filter by actor type"
            value={actorType ?? ''}
            onChange={(e) => setFilter('actorType', e.target.value || undefined)}
            className="rounded border border-surface-0 bg-mantle px-2.5 py-1.5 text-xs text-foreground focus:ring-1 focus:ring-primary/50 focus:outline-none"
          >
            <option value="">All actors</option>
            <option value="user">User</option>
            <option value="agent">Agent</option>
            <option value="system">System</option>
          </select>
        </div>

        {/* Action filter */}
        <div className="flex flex-col gap-1">
          <label htmlFor="filter-action" className="text-xs text-muted-foreground">
            Action
          </label>
          <select
            id="filter-action"
            aria-label="Filter by action"
            value={action ?? ''}
            onChange={(e) => setFilter('action', e.target.value || undefined)}
            className="rounded border border-surface-0 bg-mantle px-2.5 py-1.5 text-xs text-foreground focus:ring-1 focus:ring-primary/50 focus:outline-none"
          >
            <option value="">All actions</option>
            <option value="created">Created</option>
            <option value="updated">Updated</option>
            <option value="deleted">Deleted</option>
            <option value="status_changed">Status changed</option>
            <option value="token_issued">Token issued</option>
          </select>
        </div>

        {/* Date range filter */}
        <div className="flex flex-col gap-1">
          <label htmlFor="filter-date-range" className="text-xs text-muted-foreground">
            Date range
          </label>
          <select
            id="filter-date-range"
            aria-label="Filter by date range"
            value={dateRange}
            onChange={(e) =>
              setFilter(
                'dateRange',
                e.target.value === DEFAULT_DATE_RANGE ? undefined : e.target.value
              )
            }
            className="rounded border border-surface-0 bg-mantle px-2.5 py-1.5 text-xs text-foreground focus:ring-1 focus:ring-primary/50 focus:outline-none"
          >
            <option value="24h">Last 24 hours</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="all">All time</option>
          </select>
        </div>

        {/* Deep-link entity badge */}
        {entityId !== undefined && (
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Entity</span>
            <span className="inline-flex items-center gap-1.5 rounded border border-surface-0 bg-surface-0/30 px-2.5 py-1.5 text-xs">
              {entityType ?? 'entity'} #{entityId}
              <button
                type="button"
                aria-label="Remove entity filter"
                onClick={() => {
                  setSearchParams(
                    (prev) => {
                      const next = new URLSearchParams(prev)
                      next.delete('entityId')
                      next.delete('entityType')
                      next.delete('offset')
                      return next
                    },
                    { replace: true }
                  )
                }}
                className="text-muted-foreground hover:text-foreground"
              >
                x
              </button>
            </span>
          </div>
        )}
      </div>

      {/* Error */}
      {isError && <ErrorBanner message="Failed to load audit logs. Please try again." />}

      {/* Loading */}
      {isLoading && <EmptyState message="Loading audit logs..." />}

      {/* Out-of-range offset guard */}
      {!isLoading && !isError && hasOutOfRangeOffset && (
        <EmptyState
          message="Page offset is out of range."
          action={<Button onClick={() => goToPage(0)}>Go to first page</Button>}
        />
      )}

      {/* Empty: no events at all */}
      {!isLoading && !isError && !hasOutOfRangeOffset && total === 0 && !hasActiveFilters && (
        <EmptyState message="No audit events yet for this project." />
      )}

      {/* Empty: filters match nothing */}
      {!isLoading && !isError && !hasOutOfRangeOffset && total === 0 && hasActiveFilters && (
        <EmptyState
          message="No events match the current filters."
          action={
            <Button variant="ghost" onClick={clearFilters}>
              Clear filters
            </Button>
          }
        />
      )}

      {/* Table */}
      {!isLoading && !isError && !hasOutOfRangeOffset && total > 0 && data && (
        <>
          <Table>
            <TableHead>
              <TableRow>
                <Th>Timestamp</Th>
                <Th>Actor</Th>
                <Th>Entity</Th>
                <Th>Action</Th>
                <Th>Changes</Th>
              </TableRow>
            </TableHead>
            <TableBody>
              {data.data.map((log) => (
                <TableRow key={log.id}>
                  <Td className="text-xs whitespace-nowrap text-muted-foreground">
                    {formatTimestamp(log.createdAt)}
                  </Td>
                  <Td className="text-xs">
                    <span className="block">
                      {log.actorLabel ?? `${log.actorType} #${log.actorId ?? '?'}`}
                    </span>
                    <span className="text-[10px] text-muted-foreground capitalize">
                      {log.actorType}
                    </span>
                  </Td>
                  <Td className="text-xs">
                    <EntityCell
                      action={log.action}
                      entityType={log.entityType}
                      entityId={log.entityId}
                      entityLabel={log.entityLabel}
                    />
                    <span className="mt-0.5 block text-[10px] text-muted-foreground capitalize">
                      {log.entityType.replace(/_/g, ' ')}
                    </span>
                  </Td>
                  <Td>
                    <span className="inline-block rounded bg-surface-0/60 px-1.5 py-0.5 font-mono text-[10px] capitalize">
                      {log.action.replace(/_/g, ' ')}
                    </span>
                  </Td>
                  <Td>
                    <ChangesCell
                      action={log.action}
                      fromStatus={log.fromStatus ?? null}
                      toStatus={log.toStatus ?? null}
                      changes={log.changes}
                      rowId={log.id}
                      expandedId={expandedRowId}
                      onToggle={handleToggle}
                    />
                  </Td>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {/* Pagination */}
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {rangeStart}-{rangeEnd} of {total}
            </span>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                disabled={!hasPrev}
                onClick={() => goToPage(Math.max(0, offset - PAGE_SIZE))}
              >
                Previous
              </Button>
              <Button
                variant="ghost"
                disabled={!hasNext}
                onClick={() => goToPage(offset + PAGE_SIZE)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
