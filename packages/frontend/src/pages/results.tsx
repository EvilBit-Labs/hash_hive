import { useCallback, useMemo, useRef } from 'react'
import { useSearchParams } from 'react-router'

import type { ExportResultsFilters } from '../hooks/use-export-results'

import { ExportButton } from '../components/features/results/export-button'
import {
  type DateRangeFilter,
  ResultsFilters,
  type ResultsFiltersValue,
} from '../components/features/results/results-filters'
import { ResultsTable } from '../components/features/results/results-table'
import { Button } from '../components/ui/button'
import { EmptyState } from '../components/ui/empty-state'
import { ErrorBanner } from '../components/ui/error-banner'
import { PageHeader } from '../components/ui/page-header'
import { useResults } from '../hooks/use-results'
import { useUiStore } from '../stores/ui'

const PAGE_SIZE = 100
const POLL_INTERVAL_MS = 30_000

const VALID_DATE_RANGES: ReadonlySet<DateRangeFilter> = new Set(['24h', '7d', '30d', 'all'])
const DEFAULT_DATE_RANGE: DateRangeFilter = '30d'

const HOURS_PER_DAY = 24
const MS_PER_HOUR = 60 * 60 * 1000
const DATE_RANGE_HOURS: Record<Exclude<DateRangeFilter, 'all'>, number> = {
  '24h': 24,
  '7d': 7 * HOURS_PER_DAY,
  '30d': 30 * HOURS_PER_DAY,
}

function safeDateRange(raw: string | null): DateRangeFilter {
  if (raw && VALID_DATE_RANGES.has(raw as DateRangeFilter)) {
    return raw as DateRangeFilter
  }
  return DEFAULT_DATE_RANGE
}

function safePositiveInt(raw: string | null): number | undefined {
  if (!raw) return undefined
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : undefined
}

function safeNonNegativeInt(raw: string | null): number {
  if (!raw) return 0
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : 0
}

interface DateWindow {
  startDate?: string
  endDate?: string
}

function resolveDateWindow(range: DateRangeFilter, nowIso: string): DateWindow {
  if (range === 'all') return {}
  const now = new Date(nowIso)
  const hours = DATE_RANGE_HOURS[range]
  const start = new Date(now.getTime() - hours * MS_PER_HOUR)
  return { startDate: start.toISOString(), endDate: nowIso }
}

export function ResultsPage() {
  const selectedProjectId = useUiStore((s) => s.selectedProjectId)
  const [searchParams, setSearchParams] = useSearchParams()

  // Capture "now" once per mount. Refetches every 30s handle drift
  // without churning the TanStack Query cache key on every render.
  const nowIsoRef = useRef<string>(new Date().toISOString())

  const filters = useMemo<ResultsFiltersValue>(() => {
    const campaignId = safePositiveInt(searchParams.get('campaignId'))
    const hashListId = safePositiveInt(searchParams.get('hashListId'))
    return {
      dateRange: safeDateRange(searchParams.get('dateRange')),
      q: searchParams.get('q') ?? '',
      ...(campaignId !== undefined && { campaignId }),
      ...(hashListId !== undefined && { hashListId }),
    }
  }, [searchParams])

  const offset = safeNonNegativeInt(searchParams.get('offset'))

  const dateWindow = useMemo(
    () => resolveDateWindow(filters.dateRange, nowIsoRef.current),
    [filters.dateRange]
  )

  // ExportButton filters mirror queryFilters but drop pagination /
  // polling concerns — exports always span the full filtered set.
  // Built first so queryFilters can spread it without duplication.
  const exportFilters = useMemo<ExportResultsFilters>(
    () => ({
      ...(filters.campaignId !== undefined && { campaignId: filters.campaignId }),
      ...(filters.hashListId !== undefined && { hashListId: filters.hashListId }),
      ...(filters.q && { search: filters.q }),
      ...(dateWindow.startDate && { startDate: dateWindow.startDate }),
      ...(dateWindow.endDate && { endDate: dateWindow.endDate }),
    }),
    [filters.campaignId, filters.hashListId, filters.q, dateWindow]
  )

  const queryFilters = useMemo(
    () => ({
      ...exportFilters,
      limit: PAGE_SIZE,
      offset,
      refetchInterval: POLL_INTERVAL_MS,
    }),
    [exportFilters, offset]
  )

  const handleFiltersChange = useCallback(
    (next: ResultsFiltersValue) => {
      const params = new URLSearchParams(searchParams)
      // Filter changes always reset pagination so the operator can't
      // land on an `offset` past the new filtered total.
      params.delete('offset')

      if (next.campaignId !== undefined) params.set('campaignId', String(next.campaignId))
      else params.delete('campaignId')

      if (next.hashListId !== undefined) params.set('hashListId', String(next.hashListId))
      else params.delete('hashListId')

      // Keep the URL clean: omit `dateRange` when it equals the
      // implicit default so a fresh /results link stays parameter-free.
      if (next.dateRange !== DEFAULT_DATE_RANGE) params.set('dateRange', next.dateRange)
      else params.delete('dateRange')

      if (next.q) params.set('q', next.q)
      else params.delete('q')

      setSearchParams(params, { replace: true })
    },
    [searchParams, setSearchParams]
  )

  const goToOffset = useCallback(
    (nextOffset: number) => {
      const params = new URLSearchParams(searchParams)
      if (nextOffset > 0) params.set('offset', String(nextOffset))
      else params.delete('offset')
      setSearchParams(params, { replace: true })
    },
    [searchParams, setSearchParams]
  )

  const { data, isLoading, isError, error } = useResults(queryFilters)

  if (!selectedProjectId) {
    return (
      <div className="space-y-4">
        <PageHeader>Cracked Results</PageHeader>
        <EmptyState message="Select a project to view results." />
      </div>
    )
  }

  const total = data?.total ?? 0
  const rows = data?.results ?? []
  const hasNext = offset + PAGE_SIZE < total
  const hasPrev = offset > 0
  const rangeStart = total === 0 ? 0 : offset + 1
  const rangeEnd = Math.min(offset + PAGE_SIZE, total)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-3">
          <PageHeader>Cracked Results</PageHeader>
          <span data-testid="results-stats" className="text-xs text-muted-foreground tabular-nums">
            <span className="font-medium text-foreground">{total.toLocaleString('en-US')}</span> in
            the current filter
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ResultsFilters filters={filters} onFiltersChange={handleFiltersChange} />
          <ExportButton filters={exportFilters} />
        </div>
      </div>

      <div aria-live="polite" className="space-y-4">
        {isError && (
          <ErrorBanner
            message={error instanceof Error ? error.message : 'Failed to load cracked results'}
          />
        )}
        <ResultsTable rows={rows} isLoading={isLoading} columns="full" />

        {rows.length > 0 && (
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">
              {rangeStart}-{rangeEnd} of {total}
            </span>
            <div className="flex gap-1.5">
              <Button
                variant="secondary"
                size="sm"
                disabled={!hasPrev}
                onClick={() => goToOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                Previous
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={!hasNext}
                onClick={() => goToOffset(offset + PAGE_SIZE)}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
