import { afterEach, describe, expect, it } from 'bun:test'

import { HashListDetailPage } from '../../src/pages/hash-list-detail'
import { useUiStore } from '../../src/stores/ui'
import { mockHashListsResponse, mockResultsResponse } from '../fixtures/api-responses'
import { mockFetch, restoreFetch } from '../mocks/fetch'
import { cleanupAll, fireEvent, renderWithRouter, screen, waitFor } from '../test-utils'

let fetchMock: ReturnType<typeof mockFetch>

afterEach(() => {
  cleanupAll()
  if (fetchMock) restoreFetch(fetchMock)
})

function selectProject(projectId = 1) {
  useUiStore.setState({ selectedProjectId: projectId })
}

interface HashListDetailFixtureOptions {
  id?: number
  name?: string
  totalCount?: number
  crackedCount?: number
}

/**
 * Fixture for `GET /dashboard/resources/hash-lists/:id` matching the
 * `HashListDetailWire` shape in `@hashhive/shared/schemas/resources`.
 */
function mockHashListDetailResponse(options: HashListDetailFixtureOptions = {}) {
  const totalCount = options.totalCount ?? 1000
  const crackedCount = options.crackedCount ?? 250
  return {
    hashList: {
      id: options.id ?? 9,
      name: options.name ?? 'NTLM Sample',
      projectId: 1,
      hashTypeId: 1000,
      status: 'ready',
      statistics: {
        totalCount,
        crackedCount,
        crackRate: totalCount === 0 ? 0 : crackedCount / totalCount,
      },
      typeAnalysis: null,
      createdAt: new Date().toISOString(),
    },
  }
}

function defaultMocks(
  overrides: Record<
    string,
    { status?: number; body?: unknown; headers?: Record<string, string> }
  > = {}
) {
  return mockFetch({
    '/dashboard/resources/hash-lists/9/items': {
      status: 200,
      body: { items: [], total: 0, limit: 50, offset: 0 },
    },
    '/dashboard/resources/hash-lists/9': {
      status: 200,
      body: mockHashListDetailResponse({ id: 9, totalCount: 1000, crackedCount: 250 }),
    },
    '/dashboard/hash-lists': {
      status: 200,
      body: mockHashListsResponse({
        count: 0,
        hashLists: [],
      }),
    },
    '/dashboard/results': {
      status: 200,
      body: mockResultsResponse({ count: 0, total: 0 }),
    },
    ...overrides,
  })
}

describe('HashListDetailPage', () => {
  it('defaults to the Cracked view on mount and marks the Cracked segment active', async () => {
    fetchMock = defaultMocks({
      '/dashboard/hash-lists': {
        status: 200,
        body: {
          hashLists: [
            {
              id: 9,
              name: 'NTLM Sample',
              hashTypeId: 1000,
              hashCount: 1000,
              crackedCount: 250,
            },
          ],
        },
      },
      '/dashboard/results': {
        status: 200,
        body: mockResultsResponse({ count: 0, total: 0 }),
      },
    })

    selectProject()
    renderWithRouter([{ path: '/hash-lists/:id', element: <HashListDetailPage /> }], {
      initialRoute: '/hash-lists/9',
    })

    await waitFor(() => {
      expect(screen.getByText('NTLM Sample')).toBeDefined()
    })

    // Radix ToggleGroup type="single" renders items as role="radio" with aria-checked
    const crackedSegment = screen.getByRole('radio', { name: 'Cracked' })
    expect(crackedSegment.getAttribute('aria-checked')).toBe('true')

    const allSegment = screen.getByRole('radio', { name: 'All' })
    expect(allSegment.getAttribute('aria-checked')).toBe('false')

    const uncrackedSegment = screen.getByRole('radio', { name: 'Uncracked' })
    expect(uncrackedSegment.getAttribute('aria-checked')).toBe('false')
  })

  it('Cracked view renders ResultsStatsCard with cracked / total / rate', async () => {
    fetchMock = defaultMocks({
      '/dashboard/hash-lists': {
        status: 200,
        body: {
          hashLists: [
            {
              id: 9,
              name: 'NTLM Sample',
              hashTypeId: 1000,
              hashCount: 1000,
              crackedCount: 250,
            },
          ],
        },
      },
    })

    selectProject()
    renderWithRouter([{ path: '/hash-lists/:id', element: <HashListDetailPage /> }], {
      initialRoute: '/hash-lists/9',
    })

    await waitFor(() => {
      // The summary's cracked/hash counts win once hashLists loads.
      expect(screen.getByTestId('results-stats').textContent ?? '').toMatch(
        /250\s*\/\s*1,000\s*\(25\.0%\)/
      )
    })
  })

  it('Cracked view handles totalHashes=0 without divide-by-zero', async () => {
    fetchMock = defaultMocks({
      '/dashboard/resources/hash-lists/9': {
        status: 200,
        body: mockHashListDetailResponse({ id: 9, totalCount: 0, crackedCount: 0 }),
      },
      '/dashboard/hash-lists': {
        status: 200,
        body: {
          hashLists: [
            {
              id: 9,
              name: 'NTLM Sample',
              hashTypeId: 1000,
              hashCount: 0,
              crackedCount: 0,
            },
          ],
        },
      },
    })

    selectProject()
    renderWithRouter([{ path: '/hash-lists/:id', element: <HashListDetailPage /> }], {
      initialRoute: '/hash-lists/9',
    })

    await waitFor(() => {
      expect(screen.getByTestId('results-stats').textContent ?? '').toMatch(/0\s*\/\s*0/)
    })
  })

  it('clicking Uncracked renders the placeholder copy', async () => {
    fetchMock = defaultMocks()
    selectProject()
    renderWithRouter([{ path: '/hash-lists/:id', element: <HashListDetailPage /> }], {
      initialRoute: '/hash-lists/9',
    })

    await waitFor(() => {
      expect(screen.getByText('NTLM Sample')).toBeDefined()
    })

    fireEvent.click(screen.getByRole('radio', { name: 'Uncracked' }))

    await waitFor(() => {
      expect(screen.getByText('Uncracked listing ships next release.')).toBeDefined()
    })
  })

  it('clicking All switches to the existing hash-items view (status filter dropdown visible)', async () => {
    fetchMock = defaultMocks({
      '/dashboard/resources/hash-lists/9/items': {
        status: 200,
        body: {
          items: [
            {
              id: 1,
              hashValue: '5f4dcc3b5aa765d61d8327deb882cf99',
              plaintext: 'password',
              crackedAt: new Date().toISOString(),
              agentId: 1,
            },
          ],
          total: 1,
          limit: 50,
          offset: 0,
        },
      },
    })

    selectProject()
    renderWithRouter([{ path: '/hash-lists/:id', element: <HashListDetailPage /> }], {
      initialRoute: '/hash-lists/9',
    })

    await waitFor(() => {
      expect(screen.getByText('NTLM Sample')).toBeDefined()
    })

    fireEvent.click(screen.getByRole('radio', { name: 'All' }))

    await waitFor(() => {
      expect(screen.getByLabelText('Filter by crack status')).toBeDefined()
    })
    expect(screen.getByPlaceholderText('Search hashes...')).toBeDefined()
  })

  it('Cracked view requests /dashboard/results with hashListId and limit=100', async () => {
    fetchMock = defaultMocks()

    selectProject()
    renderWithRouter([{ path: '/hash-lists/:id', element: <HashListDetailPage /> }], {
      initialRoute: '/hash-lists/9',
    })

    await waitFor(() => {
      const calls = fetchMock.mock.calls as Array<[string, ...unknown[]]>
      const resultsCall = calls.find(([url]) => {
        const s = url
        return (
          s.includes('/dashboard/results') && s.includes('hashListId=9') && s.includes('limit=100')
        )
      })
      expect(resultsCall).toBeDefined()
    })
  })

  it('renders Export CSV button in the page header', async () => {
    fetchMock = defaultMocks()
    selectProject()
    renderWithRouter([{ path: '/hash-lists/:id', element: <HashListDetailPage /> }], {
      initialRoute: '/hash-lists/9',
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Export CSV' })).toBeDefined()
    })

    const exportButton = screen.getByRole('button', { name: 'Export CSV' }) as HTMLButtonElement
    expect(exportButton.disabled).toBe(false)
  })
})

describe('HashListDetailPage split-parent aggregated view (issue #202 SU5/SU6)', () => {
  it('renders nothing new for a normal (never-split) list — no subCampaignProgress, no needsTypeCount', async () => {
    fetchMock = defaultMocks()
    selectProject()
    renderWithRouter([{ path: '/hash-lists/:id', element: <HashListDetailPage /> }], {
      initialRoute: '/hash-lists/9',
    })

    await waitFor(() => {
      expect(screen.getByText('NTLM Sample')).toBeDefined()
    })

    expect(screen.queryByText('Sub-Campaign Progress')).toBeNull()
    expect(screen.queryByText(/still need a type/)).toBeNull()
  })

  it('renders the aggregated progress summary when subCampaignProgress is present', async () => {
    fetchMock = defaultMocks({
      '/dashboard/resources/hash-lists/9': {
        status: 200,
        body: {
          hashList: {
            ...mockHashListDetailResponse({ id: 9, totalCount: 1000, crackedCount: 250 }).hashList,
            subCampaignProgress: {
              subCampaignCount: 3,
              completedSubCampaignCount: 2,
              done: false,
              totalTasks: 10,
              completedTasks: 7,
              tasksFailed: 1,
              overallProgress: 0.7,
              hashProgress: { total: 900, cracked: 600, remaining: 300, percentage: 0.667 },
              pendingSubCampaignCount: 0,
            },
          },
        },
      },
    })
    selectProject()
    renderWithRouter([{ path: '/hash-lists/:id', element: <HashListDetailPage /> }], {
      initialRoute: '/hash-lists/9',
    })

    await waitFor(() => {
      expect(screen.getByText('Sub-Campaign Progress')).toBeDefined()
    })
    expect(screen.getByText('2/3')).toBeDefined()
    expect(screen.getByText('7/10')).toBeDefined()
    expect(screen.getByText('600/900')).toBeDefined()
    // Not done — no needs-type notice was configured, and status reads "running".
    expect(screen.queryByText(/still need a type/)).toBeNull()
  })

  it('renders a distinct needs-type notice when needsTypeCount > 0, even alongside a done summary', async () => {
    fetchMock = defaultMocks({
      '/dashboard/resources/hash-lists/9': {
        status: 200,
        body: {
          hashList: {
            ...mockHashListDetailResponse({ id: 9, totalCount: 1000, crackedCount: 900 }).hashList,
            needsTypeCount: 42,
            subCampaignProgress: {
              subCampaignCount: 2,
              completedSubCampaignCount: 2,
              done: true,
              totalTasks: 4,
              completedTasks: 4,
              tasksFailed: 0,
              overallProgress: 1,
              hashProgress: { total: 900, cracked: 900, remaining: 0, percentage: 1 },
              pendingSubCampaignCount: 0,
            },
          },
        },
      },
    })
    selectProject()
    renderWithRouter([{ path: '/hash-lists/:id', element: <HashListDetailPage /> }], {
      initialRoute: '/hash-lists/9',
    })

    await waitFor(() => {
      expect(screen.getByText('Sub-Campaign Progress')).toBeDefined()
    })
    // Both sections render together — a done parent with unresolved
    // needs-type children must not read as either "fully done" (hiding the
    // pending work) or "stalled" (contradicting the completed sub-campaigns).
    expect(screen.getByText(/42 hashes still need a type/)).toBeDefined()
  })
})
