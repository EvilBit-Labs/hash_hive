import { useState } from 'react'
import { useParams } from 'react-router'

import { CrackedStatsLine } from '../components/features/results/cracked-stats-line'
import { ExportButton } from '../components/features/results/export-button'
import { LiveIndicator } from '../components/features/results/live-indicator'
import { ResultsTable } from '../components/features/results/results-table'
import { StatusBadge } from '../components/features/status-badge'
import { Button } from '../components/ui/button'
import { EmptyState } from '../components/ui/empty-state'
import { ErrorBanner } from '../components/ui/error-banner'
import { Input } from '../components/ui/input'
import { PageHeader } from '../components/ui/page-header'
import { SegmentedControl } from '../components/ui/segmented-control'
import { Select } from '../components/ui/select'
import { Table, TableBody, TableHead, TableRow, Td, Th } from '../components/ui/table'
import { TextLink } from '../components/ui/text-link'
import { useDebounce } from '../hooks/use-debounce'
import { useHashLists } from '../hooks/use-hash-lists'
import { useHashListDetail, useHashListItems } from '../hooks/use-resources'
import { useResults } from '../hooks/use-results'
import { RESULTS_POLL_INTERVAL_MS } from '../lib/motion-tokens'

type StatusFilter = 'all' | 'cracked' | 'uncracked'
type DetailView = 'all' | 'cracked' | 'uncracked'

const PAGE_SIZE = 50
const RESULTS_PAGE_SIZE = 100
const SEARCH_DEBOUNCE_MS = 300

const VIEW_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'cracked', label: 'Cracked' },
  { value: 'uncracked', label: 'Uncracked' },
] as const

const UNCRACKED_PLACEHOLDER = 'Uncracked listing ships next release.'

export function HashListDetailPage() {
  const { id } = useParams<{ id: string }>()
  // Guard against malformed `/hash-lists/<garbage>` URLs (e.g. stale
  // bookmarks, typos). Without this `Number(id)` would yield `NaN`,
  // which propagates as `?hashListId=NaN` on every downstream query.
  // We still need to run all hooks unconditionally so we substitute
  // 0 and surface the error state after the hook section.
  const parsedId = id !== undefined ? Number(id) : Number.NaN
  const isValidId = Number.isInteger(parsedId) && parsedId > 0
  const hashListId = isValidId ? parsedId : 0

  const [view, setView] = useState<DetailView>('cracked')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [search, setSearch] = useState('')
  const debouncedSearch = useDebounce(search, SEARCH_DEBOUNCE_MS)
  const [offset, setOffset] = useState(0)
  const [resultsOffset, setResultsOffset] = useState(0)

  const { data, isLoading, isError, error } = useHashListDetail(hashListId)
  const { data: itemsData, isLoading: itemsLoading } = useHashListItems(hashListId, {
    status: statusFilter,
    ...(debouncedSearch ? { search: debouncedSearch } : {}),
    limit: PAGE_SIZE,
    offset,
  })

  // Cracked-view data sources. Both are project-scoped hooks; the
  // hash-list summary feeds the stats card numerator/denominator, and
  // useResults paginates the cracked-result table at 100 rows with the
  // 30s polling cadence the Results page uses.
  const { data: hashListsData } = useHashLists({ enabled: view === 'cracked' })
  const resultsQuery = useResults({
    hashListId,
    limit: RESULTS_PAGE_SIZE,
    offset: resultsOffset,
    refetchInterval: RESULTS_POLL_INTERVAL_MS,
    enabled: view === 'cracked',
  })

  if (!isValidId) {
    return (
      <div className="space-y-4">
        <PageHeader>Hash List</PageHeader>
        <ErrorBanner message={`Invalid hash list id: ${id ?? '(none)'}`} />
      </div>
    )
  }

  if (isLoading) return <EmptyState message="Loading hash list..." />

  if (isError) {
    return (
      <div className="space-y-4">
        <TextLink to="/resources" back>
          Back to resources
        </TextLink>
        <ErrorBanner
          message={error instanceof Error ? error.message : 'Failed to load hash list'}
        />
      </div>
    )
  }

  if (!data?.hashList) {
    return (
      <div className="space-y-4">
        <TextLink to="/resources" back>
          Back to resources
        </TextLink>
        <EmptyState message="Hash list not found." />
      </div>
    )
  }

  const { hashList } = data
  const stats = hashList.statistics
  const percentage = stats.crackRate * 100
  const remaining = stats.totalCount - stats.crackedCount
  const items = itemsData?.items ?? []
  const total = itemsData?.total ?? 0
  const hasNext = offset + PAGE_SIZE < total
  const hasPrev = offset > 0

  // Stats-card source. Falls back to the detail page's own statistics
  // when the project-scoped hash-lists summary hasn't loaded yet so the
  // card renders immediately instead of waiting on a second round-trip.
  const summary = hashListsData?.hashLists.find((row) => row.id === hashListId)
  const summaryCracked = summary?.crackedCount ?? stats.crackedCount
  const summaryTotal = summary?.hashCount ?? stats.totalCount

  const resultsRows = resultsQuery.data?.results ?? []
  const resultsTotal = resultsQuery.data?.total ?? 0
  const resultsHasNext = resultsOffset + RESULTS_PAGE_SIZE < resultsTotal
  const resultsHasPrev = resultsOffset > 0

  function handleViewChange(next: string) {
    if (next !== 'all' && next !== 'cracked' && next !== 'uncracked') return
    setView(next)
    // Switching views resets both pagers so the new view always lands
    // on its first page (`offset` for `All`, `resultsOffset` for
    // `Cracked`). `Uncracked` has no pagination today.
    setOffset(0)
    setResultsOffset(0)
  }

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <TextLink to="/resources" back>
          Back to resources
        </TextLink>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <PageHeader>{hashList.name}</PageHeader>
            <StatusBadge status={hashList.status} />
          </div>
          <ExportButton filters={{ hashListId }} />
        </div>
        <SegmentedControl
          aria-label="Hash list view"
          value={view}
          onChange={handleViewChange}
          options={VIEW_OPTIONS}
        />
      </div>

      {/* Statistics cards (shared across views — the hash list summary
          is the same regardless of which tab is active). */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Total" value={stats.totalCount.toLocaleString()} />
        <StatCard
          label="Cracked"
          value={stats.crackedCount.toLocaleString()}
          className="text-success"
        />
        <StatCard label="Remaining" value={remaining.toLocaleString()} />
        <div className="rounded-md border border-surface-0 bg-surface-0/40 p-4">
          <p className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
            Progress
          </p>
          <p className="mt-2 font-mono text-2xl font-bold tabular-nums">{percentage.toFixed(1)}%</p>
          <div className="mt-2 h-1.5 w-full rounded-full bg-surface-1">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${Math.min(percentage, 100)}%` }}
            />
          </div>
        </div>
      </div>

      {view === 'all' && (
        <AllItemsView
          statusFilter={statusFilter}
          onStatusChange={(next) => {
            setStatusFilter(next)
            setOffset(0)
          }}
          search={search}
          onSearchChange={(next) => {
            setSearch(next)
            setOffset(0)
          }}
          itemsLoading={itemsLoading}
          items={items}
          total={total}
          offset={offset}
          hasPrev={hasPrev}
          hasNext={hasNext}
          onPrev={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          onNext={() => setOffset(offset + PAGE_SIZE)}
        />
      )}

      {view === 'cracked' && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-baseline gap-3">
            <CrackedStatsLine cracked={summaryCracked} total={summaryTotal} />
            <LiveIndicator />
          </div>
          {resultsQuery.isError && (
            <ErrorBanner
              message={
                resultsQuery.error instanceof Error
                  ? resultsQuery.error.message
                  : 'Failed to load cracked results'
              }
            />
          )}
          <ResultsTable
            rows={resultsRows}
            isLoading={resultsQuery.isLoading}
            columns="no-hashlist"
          />
          {resultsTotal > 0 && (
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="tabular-nums">
                Showing {resultsOffset + 1}-
                {Math.min(resultsOffset + RESULTS_PAGE_SIZE, resultsTotal)} of{' '}
                {resultsTotal.toLocaleString('en-US')}
              </span>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!resultsHasPrev}
                  onClick={() => setResultsOffset(Math.max(0, resultsOffset - RESULTS_PAGE_SIZE))}
                >
                  Previous
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!resultsHasNext}
                  onClick={() => setResultsOffset(resultsOffset + RESULTS_PAGE_SIZE)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {view === 'uncracked' && <EmptyState message={UNCRACKED_PLACEHOLDER} />}
    </div>
  )
}

interface HashItemRow {
  id: number
  hashValue: string
  plaintext: string | null
  crackedAt: string | null
  agentId: number | null
}

interface AllItemsViewProps {
  statusFilter: StatusFilter
  onStatusChange: (next: StatusFilter) => void
  search: string
  onSearchChange: (next: string) => void
  itemsLoading: boolean
  items: HashItemRow[]
  total: number
  offset: number
  hasPrev: boolean
  hasNext: boolean
  onPrev: () => void
  onNext: () => void
}

function AllItemsView({
  statusFilter,
  onStatusChange,
  search,
  onSearchChange,
  itemsLoading,
  items,
  total,
  offset,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
}: AllItemsViewProps) {
  return (
    <div className="space-y-3">
      <div className="flex gap-3">
        <Select
          aria-label="Filter by crack status"
          value={statusFilter}
          onChange={(e) => onStatusChange(e.target.value as StatusFilter)}
        >
          <option value="all">All</option>
          <option value="cracked">Cracked</option>
          <option value="uncracked">Uncracked</option>
        </Select>
        <Input
          aria-label="Search hashes"
          placeholder="Search hashes..."
          className="max-w-xs font-mono text-xs"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
        />
      </div>

      {itemsLoading ? (
        <EmptyState message="Loading hashes..." />
      ) : items.length === 0 ? (
        <EmptyState message="No hashes match your filters." />
      ) : (
        <>
          <Table>
            <TableHead>
              <tr>
                <Th>Hash Value</Th>
                <Th>Status</Th>
                <Th>Plaintext</Th>
                <Th>Cracked At</Th>
                <Th>Agent</Th>
              </tr>
            </TableHead>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id}>
                  <Td className="max-w-[300px] truncate font-mono text-xs">{item.hashValue}</Td>
                  <Td>
                    <StatusBadge status={item.crackedAt ? 'cracked' : 'uncracked'} />
                  </Td>
                  <Td className="font-mono text-xs text-success">{item.plaintext ?? '-'}</Td>
                  <Td className="text-xs text-muted-foreground">
                    {item.crackedAt ? new Date(item.crackedAt).toLocaleString() : '-'}
                  </Td>
                  <Td className="font-mono text-xs text-muted-foreground">
                    {item.agentId ? `#${item.agentId}` : '-'}
                  </Td>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              Showing {offset + 1}-{Math.min(offset + PAGE_SIZE, total)} of {total.toLocaleString()}
            </span>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" disabled={!hasPrev} onClick={onPrev}>
                Previous
              </Button>
              <Button size="sm" variant="secondary" disabled={!hasNext} onClick={onNext}>
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function StatCard({
  label,
  value,
  className,
}: {
  label: string
  value: string
  className?: string
}) {
  return (
    <div className="rounded-md border border-surface-0 bg-surface-0/40 p-4">
      <p className="text-xs font-medium tracking-wider text-muted-foreground uppercase">{label}</p>
      <p className={`mt-2 font-mono text-2xl font-bold tabular-nums ${className ?? ''}`}>{value}</p>
    </div>
  )
}
