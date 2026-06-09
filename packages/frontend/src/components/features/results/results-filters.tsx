import { useEffect, useState } from 'react'

import { useCampaigns } from '../../../hooks/use-dashboard'
import { useDebounce } from '../../../hooks/use-debounce'
import { useHashLists } from '../../../hooks/use-hash-lists'
import { Input } from '../../ui/input'
import { Select } from '../../ui/select'

export type DateRangeFilter = '24h' | '7d' | '30d' | 'all'

export interface ResultsFiltersValue {
  readonly campaignId?: number
  readonly hashListId?: number
  readonly dateRange: DateRangeFilter
  readonly q: string
}

interface ResultsFiltersProps {
  readonly filters: ResultsFiltersValue
  readonly onFiltersChange: (next: ResultsFiltersValue) => void
}

interface CampaignOption {
  id: number
  name: string
}

const DATE_RANGE_OPTIONS: ReadonlyArray<{ value: DateRangeFilter; label: string }> = [
  { value: '24h', label: 'Last 24h' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'all', label: 'All time' },
]

const SEARCH_DEBOUNCE_MS = 300

/**
 * Filter strip for the global Results page (U7). Provides four
 * controls: Campaign Select, Hash List Select, Date Range Select, and
 * a debounced free-text Search Input.
 *
 * The hash-list dropdown is lazy: the `useHashLists` query stays
 * disabled until the operator opens (focuses) the select, unless the
 * URL already pins a `hashListId` filter — in which case we need the
 * options eagerly so the resolved label can render correctly.
 *
 * Filter changes are emitted via `onFiltersChange`; the parent owns
 * URL-state persistence and `offset=0` reset semantics.
 */
export function ResultsFilters({ filters, onFiltersChange }: ResultsFiltersProps) {
  const [hashListMenuOpened, setHashListMenuOpened] = useState(false)
  const hashListEnabled = hashListMenuOpened || filters.hashListId !== undefined

  // Local input state lets us debounce the URL/query write without
  // making the input feel laggy. Seed from `filters.q` so deep-links
  // with `?q=foo` populate the field on mount.
  const [searchInput, setSearchInput] = useState(filters.q)
  const debouncedSearch = useDebounce(searchInput, SEARCH_DEBOUNCE_MS)

  // Campaigns are cheap (already loaded for the Campaigns page) and the
  // dropdown is almost always exercised, so we fetch eagerly.
  const campaignsQuery = useCampaigns()
  const hashListsQuery = useHashLists({ enabled: hashListEnabled })

  const campaigns = (campaignsQuery.data?.campaigns ?? []) as ReadonlyArray<CampaignOption>
  const hashLists = hashListsQuery.data?.hashLists ?? []

  // Propagate the debounced search up. We bail when the debounced value
  // already matches the parent's filter so we don't fire a redundant
  // `onFiltersChange` on every keystroke / mount.
  useEffect(() => {
    if (debouncedSearch === filters.q) return
    onFiltersChange({ ...filters, q: debouncedSearch })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onFiltersChange and filters are intentionally excluded to avoid feedback loops
  }, [debouncedSearch])

  // If the parent resets `q` (e.g. operator clicks a "clear filters"
  // affordance later), keep the local input in sync.
  useEffect(() => {
    if (filters.q !== debouncedSearch) {
      setSearchInput(filters.q)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to parent-driven changes
  }, [filters.q])

  function handleCampaignChange(value: string) {
    const parsed = value ? Number(value) : undefined
    const campaignId = Number.isInteger(parsed) && parsed && parsed > 0 ? parsed : undefined
    const { campaignId: _omit, ...rest } = filters
    onFiltersChange(campaignId === undefined ? rest : { ...rest, campaignId })
  }

  function handleHashListChange(value: string) {
    const parsed = value ? Number(value) : undefined
    const hashListId = Number.isInteger(parsed) && parsed && parsed > 0 ? parsed : undefined
    const { hashListId: _omit, ...rest } = filters
    onFiltersChange(hashListId === undefined ? rest : { ...rest, hashListId })
  }

  function handleDateRangeChange(value: string) {
    const next = DATE_RANGE_OPTIONS.find((opt) => opt.value === value)?.value ?? '30d'
    onFiltersChange({ ...filters, dateRange: next })
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        aria-label="Filter by campaign"
        className="w-auto px-3 py-1.5 text-xs"
        value={filters.campaignId !== undefined ? String(filters.campaignId) : ''}
        onChange={(e) => handleCampaignChange(e.target.value)}
      >
        <option value="">All campaigns</option>
        {campaigns.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </Select>

      <Select
        aria-label="Filter by hash list"
        className="w-auto px-3 py-1.5 text-xs"
        value={filters.hashListId !== undefined ? String(filters.hashListId) : ''}
        onFocus={() => setHashListMenuOpened(true)}
        onMouseDown={() => setHashListMenuOpened(true)}
        onChange={(e) => handleHashListChange(e.target.value)}
      >
        <option value="">All hash lists</option>
        {hashLists.map((h) => (
          <option key={h.id} value={h.id}>
            {h.name}
          </option>
        ))}
      </Select>

      <Select
        aria-label="Filter by date range"
        className="w-auto px-3 py-1.5 text-xs"
        value={filters.dateRange}
        onChange={(e) => handleDateRangeChange(e.target.value)}
      >
        {DATE_RANGE_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </Select>

      <Input
        aria-label="Search hashes or plaintexts"
        placeholder="Search hashes or plaintexts..."
        className="w-auto px-3 py-1.5 text-xs"
        value={searchInput}
        onChange={(e) => setSearchInput(e.target.value)}
      />
    </div>
  )
}
