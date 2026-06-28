import { afterEach, describe, expect, it } from 'bun:test'

import { ResultsPage } from '../../src/pages/results'
import { useUiStore } from '../../src/stores/ui'
import { mockCampaignsResponse, mockResultsResponse } from '../fixtures/api-responses'
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

/**
 * Default fetch mock: stubs the three endpoints the Results page touches
 * (results, campaigns, hash-lists) so tests don't need to enumerate every
 * route in every case. Tests that need richer payloads override via the
 * `routes` parameter.
 */
function defaultMocks(
  overrides: Record<
    string,
    { status?: number; body?: unknown; headers?: Record<string, string> }
  > = {}
) {
  return mockFetch({
    '/dashboard/results': { status: 200, body: mockResultsResponse() },
    '/dashboard/campaigns': { status: 200, body: mockCampaignsResponse({ count: 0 }) },
    '/dashboard/hash-lists': { status: 200, body: { hashLists: [] } },
    ...overrides,
  })
}

describe('ResultsPage', () => {
  it('shows empty state when no project selected', () => {
    fetchMock = defaultMocks()
    renderWithProviders(<ResultsPage />)

    expect(screen.getByText('Select a project to view results.')).toBeDefined()
  })

  it('renders results table with attribution links when results are returned', async () => {
    const data = mockResultsResponse({
      count: 2,
      results: [
        {
          id: 1,
          hashValue: 'abc123def456',
          plaintext: 'password1',
          campaignName: 'NTLM Campaign',
          campaignId: 11,
          hashListName: 'Main List',
          hashListId: 5,
        },
        {
          id: 2,
          hashValue: 'xyz789uvw012',
          plaintext: 'secret42',
          campaignName: 'WPA Campaign',
          campaignId: 22,
          hashListName: 'WiFi List',
          hashListId: 7,
        },
      ],
      total: 2,
    })

    fetchMock = defaultMocks({
      '/dashboard/results': { status: 200, body: data },
    })

    selectProject()
    renderWithProviders(<ResultsPage />)

    await waitFor(() => {
      expect(screen.getByText('abc123def456')).toBeDefined()
    })
    expect(screen.getByText('password1')).toBeDefined()

    // Campaign cells render as react-router Links (attribution).
    const campaignLink = screen.getByRole('link', { name: 'NTLM Campaign' })
    expect(campaignLink.getAttribute('href')).toBe('/campaigns/11')

    // Hash list cells render as react-router Links.
    const hashListLink = screen.getByRole('link', { name: 'Main List' })
    expect(hashListLink.getAttribute('href')).toBe('/hash-lists/5')
  })

  it('shows no results message when API returns empty list', async () => {
    fetchMock = defaultMocks({
      '/dashboard/results': {
        status: 200,
        body: { results: [], total: 0, limit: 100, offset: 0 },
      },
    })

    selectProject()
    renderWithProviders(<ResultsPage />)

    await waitFor(() => {
      expect(screen.getByText('No cracks in the current filter.')).toBeDefined()
    })
  })

  it('mounts /results with no params and renders the 30-day window', async () => {
    fetchMock = defaultMocks()
    selectProject()
    renderWithProviders(<ResultsPage />, { initialRoute: '/results' })

    await waitFor(() => {
      const calls = fetchMock.mock.calls as Array<[string, ...unknown[]]>
      const resultsCall = calls.find(([url]) => String(url).includes('/dashboard/results'))
      expect(resultsCall).toBeDefined()
    })

    const calls = fetchMock.mock.calls as Array<[string, ...unknown[]]>
    const resultsUrl = String(
      calls.find(([url]) => String(url).includes('/dashboard/results'))?.[0]
    )

    // 30d default resolves to a ~30-day startDate/endDate window.
    expect(resultsUrl).toContain('startDate=')
    expect(resultsUrl).toContain('endDate=')

    const params = new URL(`http://x${resultsUrl.slice(resultsUrl.indexOf('?'))}`)
    const start = new Date(params.searchParams.get('startDate') ?? '')
    const end = new Date(params.searchParams.get('endDate') ?? '')
    const diffDays = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)
    expect(diffDays).toBeGreaterThan(29.5)
    expect(diffDays).toBeLessThan(30.5)
  })

  it('renders the date range combobox with the default 30d value', async () => {
    // NOTE: Selecting a date range option (e.g. "Last 24h") via Radix Select
    // is not drivable in happy-dom (portal does not mount). The "selecting 24h
    // updates the date window" assertion is covered by Playwright e2e.
    // Here we verify the combobox renders with the default label.
    fetchMock = defaultMocks()
    selectProject()
    renderWithProviders(<ResultsPage />)

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Filter by date range' })).toBeDefined()
    })

    const trigger = screen.getByRole('combobox', { name: 'Filter by date range' })
    expect(trigger.textContent).toContain('Last 30 days')
  })

  it('renders the campaign combobox (selecting a campaign requires Playwright)', async () => {
    // NOTE: Selecting a campaign option from the Radix Select requires a real
    // browser (portal does not mount in happy-dom). The "campaignId=42 + offset=0"
    // API assertion is covered by Playwright e2e. Here we verify the combobox
    // renders and campaigns load from the API.
    fetchMock = defaultMocks({
      '/dashboard/campaigns': {
        status: 200,
        body: mockCampaignsResponse({
          count: 1,
          campaigns: [{ id: 42, name: 'Sprint One' }],
        }),
      },
      '/dashboard/results': {
        status: 200,
        body: mockResultsResponse({ count: 3, total: 250 }),
      },
    })

    selectProject()
    renderWithProviders(<ResultsPage />, { initialRoute: '/results?offset=100' })

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Filter by campaign' })).toBeDefined()
    })
  })

  it('typing in search input debounces and pushes q=foo to the URL', async () => {
    fetchMock = defaultMocks()
    selectProject()
    renderWithProviders(<ResultsPage />)

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Search hashes or plaintexts...')).toBeDefined()
    })

    const searchInput = screen.getByPlaceholderText(
      'Search hashes or plaintexts...'
    ) as HTMLInputElement
    fireEvent.change(searchInput, { target: { value: 'foo' } })

    await waitFor(
      () => {
        const calls = fetchMock.mock.calls as Array<[string, ...unknown[]]>
        const searchCall = calls.find(([url]) => String(url).includes('q=foo'))
        expect(searchCall).toBeDefined()
      },
      { timeout: 1500 }
    )
  })

  it('uses 100-row pagination with Previous disabled on the first page', async () => {
    fetchMock = defaultMocks({
      '/dashboard/results': {
        status: 200,
        body: mockResultsResponse({ count: 3, total: 250 }),
      },
    })

    selectProject()
    renderWithProviders(<ResultsPage />)

    await waitFor(() => {
      expect(screen.getByText(/1-100 of 250/)).toBeDefined()
    })

    const prev = screen.getByText('Previous') as HTMLButtonElement
    expect(prev.disabled).toBe(true)

    const next = screen.getByText('Next') as HTMLButtonElement
    expect(next.disabled).toBe(false)
  })

  it('clicking Next increments offset by 100', async () => {
    fetchMock = defaultMocks({
      '/dashboard/results': {
        status: 200,
        body: mockResultsResponse({ count: 3, total: 250 }),
      },
    })

    selectProject()
    renderWithProviders(<ResultsPage />)

    await waitFor(() => {
      expect(screen.getByText('Next')).toBeDefined()
    })

    fireEvent.click(screen.getByText('Next'))

    await waitFor(() => {
      expect(screen.getByText(/101-200 of 250/)).toBeDefined()
    })

    const calls = fetchMock.mock.calls as Array<[string, ...unknown[]]>
    const offsetCall = calls.find(([url]) => String(url).includes('offset=100'))
    expect(offsetCall).toBeDefined()
  })

  it('renders Export CSV button', async () => {
    fetchMock = defaultMocks()
    selectProject()
    renderWithProviders(<ResultsPage />)

    await waitFor(() => {
      // The button's accessible name now includes the Kbd shortcut chip
      // ("Export CSV E"); match with a partial regex so future shortcut
      // changes don't break the assertion.
      expect(screen.getByRole('button', { name: /Export CSV/ })).toBeDefined()
    })
    const exportButton = screen.getByRole('button', { name: /Export CSV/ }) as HTMLButtonElement
    expect(exportButton.disabled).toBe(false)
  })

  it('passes limit=100 to the results query', async () => {
    fetchMock = defaultMocks()
    selectProject()
    renderWithProviders(<ResultsPage />)

    await waitFor(() => {
      const calls = fetchMock.mock.calls as Array<[string, ...unknown[]]>
      const limitCall = calls.find(([url]) => String(url).includes('limit=100'))
      expect(limitCall).toBeDefined()
    })
  })

  it('refetches the results query when the `r` shortcut is pressed', async () => {
    fetchMock = defaultMocks()
    selectProject()
    renderWithProviders(<ResultsPage />)

    // Wait for the initial /dashboard/results fetch to land.
    await waitFor(() => {
      const calls = fetchMock.mock.calls as Array<[string, ...unknown[]]>
      const resultsCall = calls.find(([url]) => String(url).includes('/dashboard/results'))
      expect(resultsCall).toBeDefined()
    })

    const initialResultsCallCount = (fetchMock.mock.calls as Array<[string, ...unknown[]]>).filter(
      ([url]) => String(url).includes('/dashboard/results')
    ).length

    // Press `r` to invalidate; the page should re-issue the /dashboard/results request.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r' }))

    await waitFor(() => {
      const next = (fetchMock.mock.calls as Array<[string, ...unknown[]]>).filter(([url]) =>
        String(url).includes('/dashboard/results')
      ).length
      expect(next).toBeGreaterThan(initialResultsCallCount)
    })
  })
})
