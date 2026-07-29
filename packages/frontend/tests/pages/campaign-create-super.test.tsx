import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

import { useAuthStore } from '../../src/stores/auth'
import { useUiStore } from '../../src/stores/ui'
import { mockFetch, restoreFetch } from '../mocks/fetch'
import { cleanup, cleanupAll, fireEvent, renderWithProviders, screen, waitFor } from '../test-utils'

// React Flow needs DOM measurement APIs happy-dom lacks — stub it (mirrors
// campaign-create.test.tsx). The super-target path never renders the DAG
// editor, but the page statically imports reactflow, so the module mock must
// still be present at link time.
mock.module('reactflow', () => {
  function ReactFlow() {
    return <div data-testid="react-flow-stub" />
  }
  return {
    default: ReactFlow,
    Background: () => null,
    Controls: () => null,
    Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
    useNodesState: <T,>(initial: T) => [initial, () => {}, () => {}] as const,
    useEdgesState: <T,>(initial: T) => [initial, () => {}, () => {}] as const,
  }
})
mock.module('reactflow/dist/style.css', () => ({}))

const { CampaignCreatePage } = await import('../../src/pages/campaign-create')

function setAdminWithProject(projectId = 1) {
  useAuthStore.setState({
    projects: [{ projectId, projectName: 'Test Project', roles: ['admin'] }],
    hasFetchedProjects: true,
  })
  useUiStore.setState({ selectedProjectId: projectId })
}

const FANOUT_RESPONSE = {
  parentCampaignId: 100,
  superHashListId: 5,
  subCampaigns: [
    { id: 101, hashListId: 10, mode: 0, parentCampaignId: 100 },
    { id: 102, hashListId: 20, mode: 1000, parentCampaignId: 100 },
  ],
}

function routes() {
  return {
    '/dashboard/resources/hash-lists': { status: 200, body: { hashLists: [] } },
    '/dashboard/resources/hash-types': { status: 200, body: { hashTypes: [] } },
    '/dashboard/resources/wordlists': { status: 200, body: { wordlists: [] } },
    '/dashboard/resources/rulelists': { status: 200, body: { rulelists: [] } },
    '/dashboard/resources/masklists': { status: 200, body: { masklists: [] } },
    '/dashboard/attack-templates': { status: 200, body: { templates: [] } },
    '/dashboard/super-hash-lists': {
      status: 200,
      body: {
        superHashLists: [
          {
            id: 5,
            projectId: 1,
            name: 'Union A',
            archivedAt: null,
            createdAt: '2026-07-01T00:00:00Z',
            updatedAt: '2026-07-01T00:00:00Z',
          },
        ],
        total: 1,
        limit: 50,
        offset: 0,
      },
    },
    '/dashboard/campaigns': { POST: { status: 201, body: FANOUT_RESPONSE } },
  }
}

let fetchMock: ReturnType<typeof mockFetch>

beforeEach(() => {
  fetchMock = mockFetch(routes())
  setAdminWithProject()
})

afterEach(() => {
  cleanup()
  cleanupAll()
  if (fetchMock) restoreFetch(fetchMock)
})

describe('CampaignCreatePage — super target', () => {
  it('offers the super target and shows the resulting sub-campaigns on success', async () => {
    renderWithProviders(<CampaignCreatePage />)

    await waitFor(() => {
      expect(screen.getByText('Create Campaign')).toBeDefined()
    })

    // Switch the target-type toggle to the super path.
    fireEvent.click(screen.getByText('Super Hash List'))

    // The super picker renders the project's supers as radio options.
    const superOption = await screen.findByRole('radio', { name: /Union A/ })
    fireEvent.click(superOption)

    fireEvent.change(screen.getByLabelText('Campaign Name'), {
      target: { value: 'Domain sweep' },
    })

    fireEvent.click(screen.getByText('Create Super Campaign'))

    // The fan-out result panel lists the typed sub-campaigns.
    await waitFor(() => {
      expect(screen.getByText('Campaign #101')).toBeDefined()
      expect(screen.getByText('Campaign #102')).toBeDefined()
    })

    // And the POST carried superHashListId (not hashListId).
    const postCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).includes('/dashboard/campaigns') &&
        (init as RequestInit | undefined)?.method === 'POST'
    )
    if (!postCall) throw new Error('expected a POST to /dashboard/campaigns')
    const body = JSON.parse((postCall[1] as RequestInit).body as string)
    expect(body.superHashListId).toBe(5)
    expect(body.hashListId).toBeUndefined()
    expect(body.name).toBe('Domain sweep')
  })

  it('shows a loading state for supers, not the empty message, while the query is in flight', async () => {
    // Gate the /super-hash-lists response so it stays pending until we
    // release it — everything else resolves via the normal route mocks.
    let releaseSupers: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseSupers = resolve
    })
    const passthroughFetch = globalThis.fetch
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const method = ((init?.method as string) ?? 'GET').toUpperCase()
      if (url.includes('/dashboard/super-hash-lists') && method === 'GET') {
        return gate.then(() => passthroughFetch(input, init))
      }
      return passthroughFetch(input, init)
    }) as typeof fetch

    renderWithProviders(<CampaignCreatePage />)
    await waitFor(() => {
      expect(screen.getByText('Create Campaign')).toBeDefined()
    })

    fireEvent.click(screen.getByText('Super Hash List'))

    // Still pending — loading text shown, empty message NOT shown.
    expect(screen.getByText('Loading super hash lists...')).toBeDefined()
    expect(screen.queryByText(/No super hash lists in this project yet/)).toBeNull()

    releaseSupers()
    await screen.findByRole('radio', { name: /Union A/ })
  })

  it('shows an error state on supers query failure, not the empty message', async () => {
    fetchMock = mockFetch({
      ...routes(),
      '/dashboard/super-hash-lists': { status: 500, body: { error: { message: 'boom' } } },
    })

    renderWithProviders(<CampaignCreatePage />)
    await waitFor(() => {
      expect(screen.getByText('Create Campaign')).toBeDefined()
    })

    fireEvent.click(screen.getByText('Super Hash List'))

    await waitFor(() => {
      expect(screen.getByText('Failed to load super hash lists.')).toBeDefined()
    })
    expect(screen.queryByText(/No super hash lists in this project yet/)).toBeNull()

    // Retry re-issues the request.
    const callsBefore = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/dashboard/super-hash-lists')
    ).length
    fireEvent.click(screen.getByText('Retry'))
    await waitFor(() => {
      const callsAfter = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('/dashboard/super-hash-lists')
      ).length
      expect(callsAfter).toBeGreaterThan(callsBefore)
    })
  })

  it('shows the empty message only once the supers query succeeds with none', async () => {
    fetchMock = mockFetch({
      ...routes(),
      '/dashboard/super-hash-lists': {
        status: 200,
        body: { superHashLists: [], total: 0, limit: 50, offset: 0 },
      },
    })

    renderWithProviders(<CampaignCreatePage />)
    await waitFor(() => {
      expect(screen.getByText('Create Campaign')).toBeDefined()
    })

    fireEvent.click(screen.getByText('Super Hash List'))

    await waitFor(() => {
      expect(screen.getByText(/No super hash lists in this project yet/)).toBeDefined()
    })
    expect(screen.queryByText('Loading super hash lists...')).toBeNull()
    expect(screen.queryByText('Failed to load super hash lists.')).toBeNull()
  })

  it('shows a Load more control and fetches the next page when supers span more than one page', async () => {
    const rowA = {
      id: 5,
      projectId: 1,
      name: 'Union A',
      archivedAt: null,
      createdAt: '2026-07-01T00:00:00Z',
      updatedAt: '2026-07-01T00:00:00Z',
    }
    const rowB = { ...rowA, id: 6, name: 'Union B' }
    const passthroughFetch = globalThis.fetch
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const method = ((init?.method as string) ?? 'GET').toUpperCase()
      if (url.includes('/dashboard/super-hash-lists') && method === 'GET') {
        const isSecondPage = url.includes('offset=1')
        const body = isSecondPage
          ? { superHashLists: [rowB], total: 2, limit: 1, offset: 1 }
          : { superHashLists: [rowA], total: 2, limit: 1, offset: 0 }
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
      }
      return passthroughFetch(input, init)
    }) as typeof fetch

    renderWithProviders(<CampaignCreatePage />)
    await waitFor(() => {
      expect(screen.getByText('Create Campaign')).toBeDefined()
    })

    fireEvent.click(screen.getByText('Super Hash List'))

    await screen.findByRole('radio', { name: /Union A/ })
    expect(screen.queryByRole('radio', { name: /Union B/ })).toBeNull()
    expect(screen.getByText('Load more')).toBeDefined()

    fireEvent.click(screen.getByText('Load more'))

    await waitFor(() => {
      expect(screen.getByRole('radio', { name: /Union B/ })).toBeDefined()
    })
    // Both pages stay selectable — the first page's option is not dropped.
    expect(screen.getByRole('radio', { name: /Union A/ })).toBeDefined()
  })
})
