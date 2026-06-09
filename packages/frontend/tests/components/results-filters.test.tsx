import { afterEach, describe, expect, it, mock } from 'bun:test'

import {
  ResultsFilters,
  type ResultsFiltersValue,
} from '../../src/components/features/results/results-filters'
import { useUiStore } from '../../src/stores/ui'
import { mockCampaignsResponse, mockHashListsResponse } from '../fixtures/api-responses'
import { mockFetch, restoreFetch } from '../mocks/fetch'
import { cleanupAll, fireEvent, renderWithProviders, screen, waitFor } from '../test-utils'

let fetchMock: ReturnType<typeof mockFetch>

afterEach(() => {
  cleanupAll()
  if (fetchMock) restoreFetch(fetchMock)
})

function selectProject(projectId = 1) {
  useUiStore.setState({ selectedProjectId: projectId })
}

function baseFilters(overrides: Partial<ResultsFiltersValue> = {}): ResultsFiltersValue {
  return {
    dateRange: '30d',
    q: '',
    ...overrides,
  }
}

describe('ResultsFilters', () => {
  it('renders all four filter controls', () => {
    fetchMock = mockFetch({
      '/dashboard/campaigns': { status: 200, body: mockCampaignsResponse({ count: 0 }) },
    })
    selectProject()

    renderWithProviders(<ResultsFilters filters={baseFilters()} onFiltersChange={mock(() => {})} />)

    expect(screen.getByLabelText('Filter by campaign')).toBeDefined()
    expect(screen.getByLabelText('Filter by hash list')).toBeDefined()
    expect(screen.getByLabelText('Filter by date range')).toBeDefined()
    expect(screen.getByPlaceholderText('Search hashes or plaintexts...')).toBeDefined()
  })

  it('shows "Last 30 days" as the date range default', () => {
    fetchMock = mockFetch({
      '/dashboard/campaigns': { status: 200, body: mockCampaignsResponse({ count: 0 }) },
    })
    selectProject()

    renderWithProviders(<ResultsFilters filters={baseFilters()} onFiltersChange={mock(() => {})} />)

    const dateSelect = screen.getByLabelText('Filter by date range') as HTMLSelectElement
    expect(dateSelect.value).toBe('30d')
  })

  it('calls onFiltersChange with new dateRange when an option is selected', () => {
    fetchMock = mockFetch({
      '/dashboard/campaigns': { status: 200, body: mockCampaignsResponse({ count: 0 }) },
    })
    selectProject()

    const onFiltersChange = mock((_next: ResultsFiltersValue) => {})
    renderWithProviders(
      <ResultsFilters filters={baseFilters()} onFiltersChange={onFiltersChange} />
    )

    const dateSelect = screen.getByLabelText('Filter by date range') as HTMLSelectElement
    fireEvent.change(dateSelect, { target: { value: '24h' } })

    expect(onFiltersChange.mock.calls.length).toBe(1)
    const arg = onFiltersChange.mock.calls[0]?.[0] as ResultsFiltersValue
    expect(arg.dateRange).toBe('24h')
  })

  it('debounces search input by 300ms before emitting onFiltersChange', async () => {
    fetchMock = mockFetch({
      '/dashboard/campaigns': { status: 200, body: mockCampaignsResponse({ count: 0 }) },
    })
    selectProject()

    const onFiltersChange = mock((_next: ResultsFiltersValue) => {})
    renderWithProviders(
      <ResultsFilters filters={baseFilters()} onFiltersChange={onFiltersChange} />
    )

    const search = screen.getByPlaceholderText('Search hashes or plaintexts...') as HTMLInputElement
    fireEvent.change(search, { target: { value: 'pa' } })
    fireEvent.change(search, { target: { value: 'pass' } })
    fireEvent.change(search, { target: { value: 'password' } })

    // Immediately after typing, no emission yet (debounce window open).
    expect(onFiltersChange.mock.calls.length).toBe(0)

    await waitFor(
      () => {
        expect(onFiltersChange.mock.calls.length).toBeGreaterThanOrEqual(1)
      },
      { timeout: 1000 }
    )

    const last = onFiltersChange.mock.calls.at(-1)?.[0] as ResultsFiltersValue
    expect(last.q).toBe('password')
  })

  it('renders campaign options from useCampaigns()', async () => {
    fetchMock = mockFetch({
      '/dashboard/campaigns': {
        status: 200,
        body: mockCampaignsResponse({
          count: 2,
          campaigns: [
            { id: 11, name: 'NTLM Crack' },
            { id: 22, name: 'WPA Crack' },
          ],
        }),
      },
    })
    selectProject()

    renderWithProviders(<ResultsFilters filters={baseFilters()} onFiltersChange={mock(() => {})} />)

    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'NTLM Crack' })).toBeDefined()
    })
    expect(screen.getByRole('option', { name: 'WPA Crack' })).toBeDefined()
  })

  it('defers hash-list fetch until the dropdown is interacted with', async () => {
    fetchMock = mockFetch({
      '/dashboard/campaigns': { status: 200, body: mockCampaignsResponse({ count: 0 }) },
      '/dashboard/hash-lists': {
        status: 200,
        body: mockHashListsResponse({
          count: 1,
          hashLists: [{ id: 5, name: 'Corporate Leak' }],
        }),
      },
    })
    selectProject()

    renderWithProviders(<ResultsFilters filters={baseFilters()} onFiltersChange={mock(() => {})} />)

    // Initial mount: campaigns fetched, but NOT hash-lists.
    await waitFor(() => {
      const calls = fetchMock.mock.calls as Array<[string, ...unknown[]]>
      expect(calls.some(([url]) => String(url).includes('/dashboard/campaigns'))).toBe(true)
    })
    const initialCalls = fetchMock.mock.calls as Array<[string, ...unknown[]]>
    expect(initialCalls.some(([url]) => String(url).includes('/dashboard/hash-lists'))).toBe(false)

    // Open the hash-list select → triggers lazy load.
    const hashListSelect = screen.getByLabelText('Filter by hash list')
    fireEvent.mouseDown(hashListSelect)

    await waitFor(() => {
      const calls = fetchMock.mock.calls as Array<[string, ...unknown[]]>
      expect(calls.some(([url]) => String(url).includes('/dashboard/hash-lists'))).toBe(true)
    })
  })

  it('fetches hash-lists eagerly when filters.hashListId is preset', async () => {
    fetchMock = mockFetch({
      '/dashboard/campaigns': { status: 200, body: mockCampaignsResponse({ count: 0 }) },
      '/dashboard/hash-lists': {
        status: 200,
        body: mockHashListsResponse({
          count: 1,
          hashLists: [{ id: 5, name: 'Corporate Leak' }],
        }),
      },
    })
    selectProject()

    renderWithProviders(
      <ResultsFilters filters={baseFilters({ hashListId: 5 })} onFiltersChange={mock(() => {})} />
    )

    await waitFor(() => {
      const calls = fetchMock.mock.calls as Array<[string, ...unknown[]]>
      expect(calls.some(([url]) => String(url).includes('/dashboard/hash-lists'))).toBe(true)
    })
  })
})
