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

    const crackedSegment = screen.getByRole('button', { name: 'Cracked' })
    expect(crackedSegment.getAttribute('aria-pressed')).toBe('true')

    const allSegment = screen.getByRole('button', { name: 'All' })
    expect(allSegment.getAttribute('aria-pressed')).toBe('false')

    const uncrackedSegment = screen.getByRole('button', { name: 'Uncracked' })
    expect(uncrackedSegment.getAttribute('aria-pressed')).toBe('false')
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
      expect(screen.getByText('250 / 1,000 (25.0%)')).toBeDefined()
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
      expect(screen.getByText('0 / 0 (0.0%)')).toBeDefined()
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

    fireEvent.click(screen.getByRole('button', { name: 'Uncracked' }))

    await waitFor(() => {
      expect(
        screen.getByText(
          'Uncracked listing is coming in the next release. For now, see the Cracked tab.'
        )
      ).toBeDefined()
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

    fireEvent.click(screen.getByRole('button', { name: 'All' }))

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
        const s = String(url)
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
