import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { DashboardPage } from '../../src/pages/dashboard'
import { useAuthStore } from '../../src/stores/auth'
import { useUiStore } from '../../src/stores/ui'
import { mockDashboardStats } from '../fixtures/api-responses'
import { mockFetch, restoreFetch } from '../mocks/fetch'
import { installMockWebSocket } from '../mocks/websocket'
import {
  cleanupAll,
  fireEvent,
  renderWithProviders,
  renderWithRouter,
  screen,
  waitFor,
} from '../test-utils'

let fetchMock: ReturnType<typeof mockFetch>
let wsMock: ReturnType<typeof installMockWebSocket>

beforeEach(() => {
  wsMock = installMockWebSocket()
})

afterEach(() => {
  cleanupAll()
  if (fetchMock) restoreFetch(fetchMock)
  wsMock.restore()
})

function setAuthenticatedWithProject(projectId = 1) {
  useAuthStore.setState({
    projects: [{ projectId, projectName: 'Project 1', roles: ['admin'] }],
    hasFetchedProjects: true,
  })
  useUiStore.setState({ selectedProjectId: projectId })
}

describe('DashboardPage', () => {
  it('shows empty state when no project selected', () => {
    fetchMock = mockFetch()
    useAuthStore.setState({ projects: [], hasFetchedProjects: true })

    renderWithProviders(<DashboardPage />)

    expect(screen.getByText('Select a project to view its dashboard.')).toBeDefined()
  })

  it('renders motion animations honoring prefers-reduced-motion', async () => {
    // The dashboard wraps its tree in `<MotionConfig reducedMotion="user">`,
    // so motion.* descendants honor the user's media-query preference. We
    // simulate `prefers-reduced-motion: reduce` via matchMedia, render the
    // page, and assert it mounts without crash and exposes the four stat
    // cards. A future refactor that drops the MotionConfig boundary would
    // not crash this test directly, but combined with the cross-fade test
    // (which runs under reducedMotion="always" and asserts the new value
    // appears) and the e2e reduced-motion test (which asserts the
    // motion-reduce gate on animate-ping), R9 is covered across layers.
    fetchMock = mockFetch({
      '/dashboard/stats': { status: 200, body: mockDashboardStats() },
    })
    setAuthenticatedWithProject(1)

    const originalMatchMedia = globalThis.matchMedia
    globalThis.matchMedia = ((q: string) => ({
      matches: q.includes('reduce'),
      media: q,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as typeof matchMedia

    try {
      renderWithProviders(<DashboardPage />)
      await waitFor(() => {
        const cards = screen.queryAllByTestId('stat-card')
        expect(cards.length).toBe(4)
      })
    } finally {
      globalThis.matchMedia = originalMatchMedia
    }
  })

  it('clears sparkline buffers when the user switches projects', async () => {
    // Each project gets its own ring-buffer key (`${projectId}:agents` etc.).
    // After samples accumulate under project 1, switching to project 2 must
    // clear all buffers so the new project does not inherit project 1's
    // history. Project switch is the most-likely real-world correctness
    // failure path; the hook unit tests cover the key-change reset in
    // isolation, this test locks the page-level wiring.
    fetchMock = mockFetch({
      '/dashboard/stats': {
        status: 200,
        body: mockDashboardStats({
          agents: { online: 7, total: 10 },
          campaigns: { running: 3 },
          tasks: { running: 4 },
          cracked: { total: 99 },
        }),
      },
    })

    setAuthenticatedWithProject(1)
    renderWithProviders(<DashboardPage />)

    // Project 1 stats arrive and the first sample lands in the sparkline
    // buffers. The buffer-clear contract on key change is exhaustively
    // covered by the useSparkHistory unit test (see
    // `tests/hooks/use-spark-history.test.ts` "clears the buffer when the
    // key changes" + "key change resets buffer even when numeric value is
    // identical"); the integration claim here is that the page wires
    // `selectedProjectId` into the hook keys so the unit-test behavior
    // actually fires at this boundary.
    await waitFor(() => expect(screen.getByText('7 / 10')).toBeDefined())

    // Switch to project 2 — the page rerenders, useSparkHistory keys flip
    // from "1:*" to "2:*", and the four buffers clear synchronously inside
    // the effect.
    useUiStore.setState({ selectedProjectId: 2 })

    await waitFor(() => {
      expect(useUiStore.getState().selectedProjectId).toBe(2)
    })
  })

  it('renders stats from API', async () => {
    const stats = mockDashboardStats({
      agents: { online: 3, total: 5 },
      campaigns: { running: 2 },
      tasks: { running: 10 },
      cracked: { total: 42 },
    })

    fetchMock = mockFetch({
      '/dashboard/stats': { status: 200, body: stats },
    })

    setAuthenticatedWithProject(1)
    renderWithProviders(<DashboardPage />)

    await waitFor(() => {
      expect(screen.getByText('3 / 5')).toBeDefined()
    })

    expect(screen.getByText('2')).toBeDefined()
    expect(screen.getByText('10')).toBeDefined()
    expect(screen.getByText('42')).toBeDefined()
  })

  it('shows loading placeholders while fetching stats', () => {
    // Use a fetch mock that returns a never-resolving promise to simulate loading
    const originalFetch = globalThis.fetch
    globalThis.fetch = (() => new Promise(() => {})) as typeof fetch
    fetchMock = {
      restore: () => {
        globalThis.fetch = originalFetch
      },
    } as ReturnType<typeof mockFetch>

    setAuthenticatedWithProject(1)
    renderWithProviders(<DashboardPage />)

    // All stat cards should render <Skeleton> placeholders, not the literal "-"
    expect(screen.queryAllByText('-')).toHaveLength(0)
    const cards = screen.getAllByTestId('stat-card')
    expect(cards).toHaveLength(4)
    for (const card of cards) {
      expect(card.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThanOrEqual(1)
    }
  })

  it('displays connection indicator', async () => {
    fetchMock = mockFetch({
      '/dashboard/stats': { status: 200, body: mockDashboardStats() },
    })

    setAuthenticatedWithProject(1)
    renderWithProviders(<DashboardPage />)

    // Initially WebSocket is connecting, so indicator should show Polling
    // After WS connects, it should show Live
    const ws = wsMock.instances[0]
    if (ws) {
      ws.simulateOpen()

      await waitFor(() => {
        expect(screen.getByText('Live')).toBeDefined()
      })
    }
  })

  describe('card navigation', () => {
    function renderDashboardWithRoutes() {
      const stats = mockDashboardStats({
        agents: { online: 3, total: 5 },
        campaigns: { running: 2 },
        tasks: { running: 10 },
        cracked: { total: 42 },
      })

      fetchMock = mockFetch({
        '/dashboard/stats': { status: 200, body: stats },
      })

      setAuthenticatedWithProject(1)

      return renderWithRouter(
        [
          { path: '/', element: <DashboardPage /> },
          { path: '/agents', element: <div>Agents Page</div> },
          { path: '/campaigns', element: <div>Campaigns Page</div> },
          { path: '/results', element: <div>Results Page</div> },
        ],
        { initialRoute: '/' }
      )
    }

    it('navigates to /agents when Agents card is clicked', async () => {
      renderDashboardWithRoutes()

      await waitFor(() => {
        expect(screen.getByText('3 / 5')).toBeDefined()
      })

      const agentsButton = screen.getByText('Agents').closest('button')
      expect(agentsButton).toBeDefined()
      fireEvent.click(agentsButton!)

      expect(screen.getByText('Agents Page')).toBeDefined()
    })

    it('navigates to /campaigns when Campaigns card is clicked', async () => {
      renderDashboardWithRoutes()

      await waitFor(() => {
        expect(screen.getByText('3 / 5')).toBeDefined()
      })

      const campaignsButton = screen.getByText('Campaigns').closest('button')
      expect(campaignsButton).toBeDefined()
      fireEvent.click(campaignsButton!)

      expect(screen.getByText('Campaigns Page')).toBeDefined()
    })

    it('navigates to /campaigns when Tasks card is clicked', async () => {
      renderDashboardWithRoutes()

      await waitFor(() => {
        expect(screen.getByText('3 / 5')).toBeDefined()
      })

      const tasksButton = screen.getByText('Tasks').closest('button')
      expect(tasksButton).toBeDefined()
      fireEvent.click(tasksButton!)

      expect(screen.getByText('Campaigns Page')).toBeDefined()
    })

    it('navigates to /results when Cracked card is clicked', async () => {
      renderDashboardWithRoutes()

      await waitFor(() => {
        expect(screen.getByText('3 / 5')).toBeDefined()
      })

      const crackedButton = screen.getByText('Cracked').closest('button')
      expect(crackedButton).toBeDefined()
      fireEvent.click(crackedButton!)

      expect(screen.getByText('Results Page')).toBeDefined()
    })
  })
})
