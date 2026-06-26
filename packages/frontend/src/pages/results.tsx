import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'

import type { ExportResultsFilters } from '../hooks/use-export-results'

import { ExportButton } from '../components/features/results/export-button'
import { LiveIndicator } from '../components/features/results/live-indicator'
import {
  type DateRangeFilter,
  ResultsFilters,
  type ResultsFiltersValue,
} from '../components/features/results/results-filters'
import { ResultsTable } from '../components/features/results/results-table'
import { TickingNumber } from '../components/features/results/ticking-number'
import { Button } from '../components/ui/button'
import { EmptyState } from '../components/ui/empty-state'
import { ErrorBanner } from '../components/ui/error-banner'
import { PageHeader } from '../components/ui/page-header'
import { useKeyboardShortcut } from '../hooks/use-keyboard-shortcut'
import { useResults } from '../hooks/use-results'
import { RESULTS_POLL_INTERVAL_MS } from '../lib/motion-presets'
import { safeNonNegativeInt, safePositiveInt } from '../lib/search-params'
import { useUiStore } from '../stores/ui'

const PAGE_SIZE = 100

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

  // "Now" advances on the polling cadence. Mount-anchoring the
  // value would freeze the `endDate` query param so cracks landing
  // 30+ minutes into a session would never appear, even though the
  // 30s refetch would otherwise have surfaced them. The interval
  // bucket is the same as RESULTS_POLL_INTERVAL_MS so the date
  // window key changes at most once per poll.
  const [nowIso, setNowIso] = useState<string>(() => new Date().toISOString())
  useEffect(() => {
    const t = window.setInterval(
      () => setNowIso(new Date().toISOString()),
      RESULTS_POLL_INTERVAL_MS
    )
    return () => {
      window.clearInterval(t)
    }
  }, [])

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
    () => resolveDateWindow(filters.dateRange, nowIso),
    [filters.dateRange, nowIso]
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
      refetchInterval: RESULTS_POLL_INTERVAL_MS,
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

  // Power-user shortcut: `r` invalidates the current project's
  // results queries, forcing an immediate refetch. No visible Kbd
  // chip — the LiveIndicator already telegraphs that polling is
  // active; refresh is a quiet operator-grade affordance for
  // impatient runs.
  //
  // The key is scoped to `['results', selectedProjectId]` so an
  // operator who has cached results for multiple projects in the
  // same session only refetches the project they're currently
  // viewing. TanStack Query's queryKey filter matches by prefix,
  // so this catches every page/filter combination for the active
  // project but leaves other projects' caches untouched.
  const queryClient = useQueryClient()
  const refreshResults = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['results', selectedProjectId] })
  }, [queryClient, selectedProjectId])
  useKeyboardShortcut('r', refreshResults)

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
  // Out-of-range offset (operator landed on a stale `?offset=N` URL
  // after a filter narrowed the total) renders zero rows. The
  // pagination affordance still needs to be visible so the operator
  // has a way back to page 0 — gate visibility on `total > 0` rather
  // than `rows.length > 0`. The range readout clamps to total so a
  // stale offset doesn't surface confusing "301-400 of 50" output.
  const hasOutOfRangeOffset = total > 0 && offset >= total
  const hasNext = offset + PAGE_SIZE < total
  const hasPrev = offset > 0
  const rangeStart = total === 0 || hasOutOfRangeOffset ? 0 : offset + 1
  const rangeEnd = hasOutOfRangeOffset ? 0 : Math.min(offset + PAGE_SIZE, total)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-3">
          <PageHeader>Cracked Results</PageHeader>
          <LiveIndicator />
          <span data-testid="results-stats" className="text-xs text-muted-foreground tabular-nums">
            <TickingNumber value={total} className="font-semibold text-foreground">
              {total.toLocaleString('en-US')}
            </TickingNumber>{' '}
            in the current filter
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ResultsFilters
            filters={filters}
            onFiltersChange={handleFiltersChange}
            searchShortcutKey="/"
          />
          <ExportButton filters={exportFilters} shortcutKey="E" />
        </div>
      </div>

      <div aria-live="polite" className="space-y-4">
        {isError && (
          <ErrorBanner
            message={error instanceof Error ? error.message : 'Failed to load cracked results'}
          />
        )}
        <ResultsTable rows={rows} isLoading={isLoading} columns="full" />

        {(rows.length > 0 || hasOutOfRangeOffset) && (
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground tabular-nums">
              {rangeStart}-{rangeEnd} of {total.toLocaleString('en-US')}
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
