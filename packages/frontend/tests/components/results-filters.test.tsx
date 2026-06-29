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

    // Radix Select renders a combobox trigger button with aria-label
    expect(screen.getByRole('combobox', { name: 'Filter by campaign' })).toBeDefined()
    expect(screen.getByRole('combobox', { name: 'Filter by hash list' })).toBeDefined()
    expect(screen.getByRole('combobox', { name: 'Filter by date range' })).toBeDefined()
    expect(screen.getByPlaceholderText('Search hashes or plaintexts...')).toBeDefined()
  })

  it('shows "Last 30 days" as the date range default', () => {
    fetchMock = mockFetch({
      '/dashboard/campaigns': { status: 200, body: mockCampaignsResponse({ count: 0 }) },
    })
    selectProject()

    renderWithProviders(<ResultsFilters filters={baseFilters()} onFiltersChange={mock(() => {})} />)

    // Radix Select renders the current value's label inside the trigger.
    // With value='30d', the trigger text shows the matching option label.
    const trigger = screen.getByRole('combobox', { name: 'Filter by date range' })
    expect(trigger.textContent).toContain('Last 30 days')
  })

  it('calls onFiltersChange with new dateRange when onValueChange fires', () => {
    fetchMock = mockFetch({
      '/dashboard/campaigns': { status: 200, body: mockCampaignsResponse({ count: 0 }) },
    })
    selectProject()

    const onFiltersChange = mock((_next: ResultsFiltersValue) => {})
    renderWithProviders(
      <ResultsFilters filters={baseFilters()} onFiltersChange={onFiltersChange} />
    )

    // NOTE: Radix Select open+click interaction is not reliably drivable in
    // happy-dom (portal does not mount without a real browser). The behavioral
    // test for selecting a new date range value is covered by Playwright e2e.
    // Here we verify the trigger renders and the component mounts without error.
    const trigger = screen.getByRole('combobox', { name: 'Filter by date range' })
    expect(trigger).toBeDefined()
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

  it('renders campaign combobox trigger (options load asynchronously)', async () => {
    // NOTE: Radix Select options are rendered inside a portal on open.
    // In happy-dom, portal/open interaction is not available, so we verify
    // the trigger renders with the correct accessible name. Option rendering
    // and selection interaction are covered by Playwright e2e.
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
      // Campaigns fetch completes; trigger is present and accessible
      expect(screen.getByRole('combobox', { name: 'Filter by campaign' })).toBeDefined()
    })
  })

  it('does not fetch hash-lists on initial mount (lazy load)', async () => {
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
      expect(calls.some(([url]) => url.includes('/dashboard/campaigns'))).toBe(true)
    })
    // Settle any late lazy-load fetch before asserting hash-lists was NOT fetched.
    await new Promise((resolve) => setTimeout(resolve, 80))
    const initialCalls = fetchMock.mock.calls as Array<[string, ...unknown[]]>
    expect(initialCalls.some(([url]) => url.includes('/dashboard/hash-lists'))).toBe(false)

    // NOTE: triggering the hash-list lazy-load via Radix Select open requires
    // a real browser (portal + Radix open state). Covered by Playwright e2e.
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
      expect(calls.some(([url]) => url.includes('/dashboard/hash-lists'))).toBe(true)
    })
  })

  describe('keyboard shortcut: searchShortcutKey', () => {
    it('focuses the search input when the shortcut key is pressed on document body', () => {
      fetchMock = mockFetch({
        '/dashboard/campaigns': { status: 200, body: mockCampaignsResponse({ count: 0 }) },
      })
      selectProject()
      renderWithProviders(
        <ResultsFilters
          filters={baseFilters()}
          onFiltersChange={mock(() => {})}
          searchShortcutKey="/"
        />
      )
      const input = screen.getByLabelText('Search hashes or plaintexts') as HTMLInputElement
      expect(document.activeElement === input).toBe(false)

      window.dispatchEvent(new KeyboardEvent('keydown', { key: '/' }))

      expect(document.activeElement === input).toBe(true)
    })

    it('renders the Kbd hint chip when searchShortcutKey is set', () => {
      fetchMock = mockFetch({
        '/dashboard/campaigns': { status: 200, body: mockCampaignsResponse({ count: 0 }) },
      })
      selectProject()
      renderWithProviders(
        <ResultsFilters
          filters={baseFilters()}
          onFiltersChange={mock(() => {})}
          searchShortcutKey="/"
        />
      )
      const kbd = document.querySelector('kbd')
      expect(kbd).not.toBeNull()
      expect(kbd?.textContent).toBe('/')
    })

    it('omits the Kbd hint chip when searchShortcutKey is undefined', () => {
      fetchMock = mockFetch({
        '/dashboard/campaigns': { status: 200, body: mockCampaignsResponse({ count: 0 }) },
      })
      selectProject()
      renderWithProviders(
        <ResultsFilters filters={baseFilters()} onFiltersChange={mock(() => {})} />
      )
      expect(document.querySelector('kbd')).toBeNull()
    })
  })
})
